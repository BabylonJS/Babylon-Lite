import {
    getPhysicsBodyAngularVelocity,
    getPhysicsBodyInstanceCount,
    onPhysicsCollision,
    PhysicsMotionType,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyCollisionEventsEnabled,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMotionType,
    setPhysicsBodyTransform,
    setThinInstanceCount,
} from "babylon-lite";
import { applyPhysicsBodyInstanceImpulse, getPhysicsBodyInstanceLinearVelocityToRef } from "./physics-instances.js";
import type { PhysicsBody, PhysicsCollisionInfo, PhysicsWorld } from "babylon-lite";
import { matchContactAudio, playContactAudio, prepareContactAudio, relativeCollisionMetrics } from "./audio.js";
import type { ContactAudioMatch } from "./audio.js";
import { POPPER_POWER, POPPER_RADIUS, POPPER_SPEED_THRESHOLD, POPPER_STRONG_POWER, SCORE_PER_BODY } from "./constants.js";
import type { BodyRecord, PlayroomState, WorldState } from "./types.js";

function bodyPosition(record: BodyRecord, index: number): { x: number; y: number; z: number } {
    const mesh = record.mesh as { thinInstances?: { matrices: Float32Array }; position: { x: number; y: number; z: number } };
    const matrices = mesh.thinInstances?.matrices;
    if (matrices) {
        const offset = index * 16;
        return { x: matrices[offset + 12]!, y: matrices[offset + 13]!, z: matrices[offset + 14]! };
    }
    return mesh.position;
}

export function scoreCollision(state: PlayroomState, info: PhysicsCollisionInfo): void {
    if (state.scorePaused || info.type === "FINISHED") {
        return;
    }
    const a = state.world.bodiesByObject.get(info.collider);
    const b = state.world.bodiesByObject.get(info.collidedAgainst);
    if (!a || !b || (a === b && info.colliderIndex === info.collidedAgainstIndex)) {
        return;
    }
    const selected = a.family === "ground" ? b : a;
    const index = selected === b ? info.collidedAgainstIndex : info.colliderIndex;
    if (selected.active === false || selected.family === "ground" || selected.family === "wall" || selected.scored.has(index)) {
        return;
    }
    selected.scored.add(index);
    state.score += SCORE_PER_BODY;
    state.canvas.dataset.score = String(state.score);
    document.dispatchEvent(new CustomEvent("playroom-score", { detail: { point: info.point, score: state.score } }));
}

export function applyRadialExplosion(physics: PhysicsWorld, world: WorldState, source: BodyRecord, strong: boolean): number {
    const origin = bodyPosition(source, 0);
    const power = strong ? POPPER_STRONG_POWER : POPPER_POWER;
    let affected = 0;
    for (const record of world.records) {
        if (record.active === false || record.family === "ground" || record.family === "wall" || !record.mass || !world.bodiesByObject.has(record.body)) {
            continue;
        }
        const count = getPhysicsBodyInstanceCount(record.body);
        for (let index = 0; index < count; index++) {
            const position = bodyPosition(record, index);
            const dx = position.x - origin.x;
            const dy = position.y - origin.y;
            const dz = position.z - origin.z;
            const distance = Math.hypot(dx, dy, dz);
            if (distance > POPPER_RADIUS) {
                continue;
            }
            const scale = power * (1 - distance / POPPER_RADIUS);
            const inverse = distance > 1e-6 ? 1 / distance : 0;
            const impulse = record === source ? { x: 0, y: scale, z: 0 } : { x: dx * inverse * scale, y: dy * inverse * scale, z: dz * inverse * scale };
            applyPhysicsBodyInstanceImpulse(physics, record.body, index, impulse, position);
            affected++;
        }
    }
    return affected;
}

function maybePop(state: PlayroomState, record: BodyRecord, other: BodyRecord): void {
    const angularVelocity = record.family === "popper" ? getPhysicsBodyAngularVelocity(state.physics, record.body) : null;
    if (
        !state.poppersArmed ||
        record.family !== "popper" ||
        record.active === false ||
        record.popperIndex === undefined ||
        record.scored.has(-1) ||
        other.family === "ground" ||
        other === record ||
        !angularVelocity ||
        Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z) <= POPPER_SPEED_THRESHOLD
    ) {
        return;
    }
    record.scored.add(-1);
    const affected = applyRadialExplosion(state.physics, state.world, record, record.popperIndex === 0 || record.popperIndex === 2);
    record.active = false;
    const generation = (record.resetGeneration ?? 0) + 1;
    record.resetGeneration = generation;
    state.canvas.dataset.lastExplosionCount = String(affected);
    record.mesh.visible = false;
    if ("thinInstances" in record.mesh && record.mesh.thinInstances) {
        setThinInstanceCount(record.mesh, 0);
    }
    setPhysicsBodyCollisionEventsEnabled(state.physics, record.body, false);
    queueMicrotask(() => {
        if (state.disposed || record.active !== false || record.resetGeneration !== generation) {
            return;
        }
        setPhysicsBodyLinearVelocity(state.physics, record.body, { x: 0, y: 0, z: 0 });
        setPhysicsBodyAngularVelocity(state.physics, record.body, { x: 0, y: 0, z: 0 });
        setPhysicsBodyTransform(state.physics, record.body, { x: 0, y: -1000 - record.id, z: 0 }, record.mesh.rotationQuaternion);
        setPhysicsBodyMotionType(state.physics, record.body, PhysicsMotionType.STATIC);
    });
    document.dispatchEvent(new CustomEvent("playroom-popper", { detail: { point: bodyPosition(record, 0) } }));
}

export function installPhysicsEvents(state: PlayroomState): void {
    enablePhysicsEvents(state);
    const aVelocity = { x: 0, y: 0, z: 0 };
    const bVelocity = { x: 0, y: 0, z: 0 };
    const metrics = { speedSquared: 0, verticalSpeed: 0 };
    const audioMatches: ContactAudioMatch[] = [];
    onPhysicsCollision(state.physics, (info) => {
        if (state.disposed) {
            return;
        }
        scoreCollision(state, info);
        const a = state.world.bodiesByObject.get(info.collider);
        const b = state.world.bodiesByObject.get(info.collidedAgainst);
        if (a && b && info.type !== "FINISHED") {
            maybePop(state, a, b);
            maybePop(state, b, a);
            if (a.active !== false && b.active !== false) {
                const matches = matchContactAudio(a, info.colliderIndex, b, info.collidedAgainstIndex, audioMatches);
                const now = performance.now();
                let hasEligibleMatch = false;
                for (const match of matches) {
                    match.preparedKey = prepareContactAudio(state.audio, match, now);
                    hasEligibleMatch ||= match.preparedKey !== null;
                }
                if (!hasEligibleMatch) {
                    return;
                }
                getPhysicsBodyInstanceLinearVelocityToRef(state.physics, a.body, info.colliderIndex, aVelocity);
                getPhysicsBodyInstanceLinearVelocityToRef(state.physics, b.body, info.collidedAgainstIndex, bVelocity);
                relativeCollisionMetrics(aVelocity, bVelocity, metrics);
                for (const match of matches) {
                    if (match.preparedKey !== null) {
                        playContactAudio(state.audio, match, metrics.speedSquared, metrics.verticalSpeed, now, match.preparedKey);
                    }
                }
            }
        }
    });
}

export function enablePhysicsEvents(state: Pick<PlayroomState, "physics" | "world">): void {
    for (const record of state.world.records) {
        setPhysicsBodyCollisionEventsEnabled(state.physics, record.body, true);
    }
}

export function canPushBody(world: WorldState, body: PhysicsBody): boolean {
    const record = world.bodiesByObject.get(body);
    return !!record && record.active !== false && record.mass > 0 && record.family !== "ragdoll";
}
