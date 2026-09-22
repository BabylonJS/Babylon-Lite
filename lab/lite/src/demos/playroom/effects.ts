import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    billboardBlendAdditive,
    billboardBlendAlpha,
    clearBillboardSprites,
    createFacingBillboardSystem,
    createGridSpriteAtlas,
    createRibbon,
    getMeshGeometry,
    resizeMeshGeometry,
    updateMeshPositions,
    updateMeshUvs,
} from "babylon-lite";
import type { ArcRotateCamera, BillboardSpriteInit, EngineContext, FacingBillboardSpriteSystem, Mesh, NodeInputHandle, SceneContext, Texture2D, Vec3 } from "babylon-lite";
import { GAME_SCALE } from "./constants.js";
import type { PlayroomAssets } from "./types.js";

export const AIMING_SEGMENTS = 15;
export const AIMING_SPEED = 10;
export const AIMING_GRAVITY = 9.81;
export const AIMING_WIDTH = 0.2;

export const SCORE_PARTICLES = {
    capacity: 2000,
    size: 0.2,
    lifeMin: 1,
    lifeMax: 1.2,
    updateSpeed: 0.005,
} as const;

export const CHARGE_PARTICLES = {
    capacity: 2000,
    sizeMin: 0.5 * GAME_SCALE,
    sizeMax: GAME_SCALE,
    color1: [0x97 / 255, 1, 0xf0 / 255, 1] as const,
    color2: [0x33 / 255, 0xc1 / 255, 0xad / 255, 1] as const,
    colorDead: [1, 1, 1, 1] as const,
    emitRate: 50,
    emitterRadius: GAME_SCALE,
    speedMin: 0.5,
    speedMax: 1,
    lifeMin: 0.1,
    lifeMax: 0.5,
    updateSpeed: 0.01,
} as const;

export const CONFETTI_PARTICLES = {
    capacity: 2000,
    manualEmitCount: 200,
    emitRate: 200,
    emitDurationMs: 100,
    size: GAME_SCALE,
    life: 9000,
    updateSpeed: 0.01,
    powerMin: 1,
    powerMax: 2,
    radius: 1.6,
    angle: Math.PI / 2,
    gravity: -3.81,
    angularSpeedMin: -2,
    angularSpeedMax: 2,
    color1: [0.73, 0.24, 0.29, 1] as const,
    color2: [0.25, 0.2, 0.38, 1] as const,
} as const;

interface EffectParticle {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    age: number;
    life: number;
    size: number;
    rotation: number;
    angularSpeed: number;
    color: [number, number, number, number];
    kind: "score" | "charge" | "confetti";
}

export interface PlayroomEffects {
    readonly engine: EngineContext;
    readonly aiming: Mesh;
    readonly aimingPositions: Float32Array;
    readonly scoreSystem: FacingBillboardSpriteSystem;
    readonly chargeSystem: FacingBillboardSpriteSystem;
    readonly confettiSystem: FacingBillboardSpriteSystem;
    readonly scoreParticles: EffectParticle[];
    readonly chargeParticles: EffectParticle[];
    readonly confettiParticles: EffectParticle[];
    readonly spriteScratch: BillboardSpriteInit;
    readonly aimingTimeInput: NodeInputHandle | undefined;
    aimingPitch: number;
    aimingYaw: number;
    aimingTimeSeconds: number;
    aimingUvsReady: boolean;
    chargeActive: boolean;
    chargePoint: Vec3;
    chargeCarry: number;
    confettiPoint: Vec3;
    confettiEmitUntil: number;
    confettiCarry: number;
}

function createEffectSystem(scene: SceneContext, texture: Texture2D, capacity: number, additive: boolean): FacingBillboardSpriteSystem {
    const atlas = createGridSpriteAtlas(texture, { cellWidthPx: texture.width, cellHeightPx: texture.height });
    const system = createFacingBillboardSystem(atlas, { capacity, blendMode: additive ? billboardBlendAdditive : billboardBlendAlpha, order: 220 });
    addFacingBillboardSystem(scene, system);
    return system;
}

export function computeAimingPath(angle: number): Vec3[][] {
    const cosine = Math.cos(angle);
    const intercept = (2 * AIMING_SPEED * AIMING_SPEED * cosine * cosine * Math.tan(angle)) / AIMING_GRAVITY;
    const pointDistance = intercept / AIMING_SEGMENTS;
    const paths: Vec3[][] = [[], []];
    for (let i = 0; i <= AIMING_SEGMENTS; i++) {
        const x = i * pointDistance;
        const y = x * Math.tan(angle) - (AIMING_GRAVITY * x * x) / (2 * AIMING_SPEED * AIMING_SPEED * cosine * cosine);
        paths[0]!.push({ x, y, z: -AIMING_WIDTH * 0.5 });
        paths[1]!.push({ x, y, z: AIMING_WIDTH * 0.5 });
    }
    return paths;
}

function writeAimingPositions(target: Float32Array, paths: readonly Vec3[][]): void {
    let offset = 0;
    for (const path of paths) {
        for (const point of path) {
            target[offset++] = point.x;
            target[offset++] = point.y;
            target[offset++] = point.z;
        }
    }
}

function writeAimingCurve(target: Float32Array, angle: number): void {
    const cosine = Math.cos(angle);
    const tangent = Math.tan(angle);
    const pointDistance = (2 * AIMING_SPEED * AIMING_SPEED * cosine * cosine * tangent) / AIMING_GRAVITY / AIMING_SEGMENTS;
    let offset = 0;
    for (let pathIndex = 0; pathIndex < 2; pathIndex++) {
        const z = (pathIndex - 0.5) * AIMING_WIDTH;
        for (let index = 0; index <= AIMING_SEGMENTS; index++) {
            const x = index * pointDistance;
            target[offset++] = x;
            target[offset++] = x * tangent - (AIMING_GRAVITY * x * x) / (2 * AIMING_SPEED * AIMING_SPEED * cosine * cosine);
            target[offset++] = z;
        }
    }
}

function createAimingUvs(paths: readonly Vec3[][]): Float32Array | null {
    const pointCount = paths[0]!.length;
    const distances = new Float32Array(pointCount);
    let total = 0;
    for (let index = 1; index < pointCount; index++) {
        const previous = paths[0]![index - 1]!;
        const current = paths[0]![index]!;
        total += Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z);
        distances[index] = total;
    }
    if (total === 0) {
        return null;
    }
    const uvs = new Float32Array(pointCount * paths.length * 2);
    let offset = 0;
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const v = paths.length === 1 ? 0 : pathIndex / (paths.length - 1);
        for (let index = 0; index < pointCount; index++) {
            uvs[offset++] = distances[index]! / total;
            uvs[offset++] = v;
        }
    }
    return uvs;
}

function makeAimingRibbonDoubleSided(engine: EngineContext, aiming: Mesh): void {
    const geometry = getMeshGeometry(aiming);
    if (!geometry) {
        throw new Error("The Playroom aiming ribbon geometry is unavailable.");
    }
    const frontIndexCount = geometry.indices.length;
    const indices = new Uint32Array(frontIndexCount * 2);
    indices.set(geometry.indices);
    for (let index = 0; index < frontIndexCount; index += 3) {
        indices[frontIndexCount + index] = geometry.indices[index]!;
        indices[frontIndexCount + index + 1] = geometry.indices[index + 2]!;
        indices[frontIndexCount + index + 2] = geometry.indices[index + 1]!;
    }
    resizeMeshGeometry(engine, aiming, geometry.positions, geometry.normals, indices, geometry.uvs);
}

export function createPlayroomEffects(engine: EngineContext, scene: SceneContext, assets: PlayroomAssets): PlayroomEffects {
    const paths = computeAimingPath(0);
    const aiming = createRibbon(engine, { pathArray: paths });
    makeAimingRibbonDoubleSided(engine, aiming);
    aiming.material = assets.aimingMaterial;
    aiming.visible = false;
    aiming.pickable = false;
    addToScene(scene, aiming);
    const aimingPositions = new Float32Array((AIMING_SEGMENTS + 1) * 2 * 3);
    writeAimingPositions(aimingPositions, paths);
    return {
        engine,
        aiming,
        aimingPositions,
        scoreSystem: createEffectSystem(scene, assets.textures.pointStar!, SCORE_PARTICLES.capacity, false),
        chargeSystem: createEffectSystem(scene, assets.textures.flare!, CHARGE_PARTICLES.capacity, true),
        confettiSystem: createEffectSystem(scene, assets.textures.confetti!, CONFETTI_PARTICLES.capacity, true),
        scoreParticles: [],
        chargeParticles: [],
        confettiParticles: [],
        spriteScratch: { position: [0, 0, 0], sizeWorld: [0, 0], color: [0, 0, 0, 0], rotation: 0 },
        aimingTimeInput: assets.aimingMaterial.inputs.Time,
        aimingPitch: 0,
        aimingYaw: 0,
        aimingTimeSeconds: 0,
        aimingUvsReady: false,
        chargeActive: false,
        chargePoint: { x: 0, y: 0, z: 0 },
        chargeCarry: 0,
        confettiPoint: { x: 0, y: 0, z: 0 },
        confettiEmitUntil: 0,
        confettiCarry: 0,
    };
}

export function updateAimingEffect(effects: PlayroomEffects, origin: Vec3, camera: ArcRotateCamera, visible: boolean): void {
    effects.aiming.visible = visible;
    if (!visible) {
        return;
    }
    const targetPitch = camera.beta - Math.PI * 0.25;
    const targetYaw = -camera.alpha + Math.PI;
    effects.aimingPitch += (targetPitch - effects.aimingPitch) * 0.1;
    effects.aimingYaw += (targetYaw - effects.aimingYaw) * 0.1;
    if (!effects.aimingUvsReady) {
        const paths = computeAimingPath(effects.aimingPitch);
        const uvs = createAimingUvs(paths);
        if (uvs) {
            updateMeshUvs(effects.engine, effects.aiming, uvs);
            effects.aimingUvsReady = true;
        }
    }
    writeAimingCurve(effects.aimingPositions, effects.aimingPitch);
    updateMeshPositions(effects.engine, effects.aiming, effects.aimingPositions);
    const horizontal = Math.cos(targetPitch);
    effects.aiming.position.set(origin.x - Math.cos(camera.alpha) * horizontal * 0.5, origin.y, origin.z - Math.sin(camera.alpha) * horizontal * 0.5);
    effects.aiming.rotation.y = effects.aimingYaw;
}

function randomBetween(minimum: number, maximum: number): number {
    return minimum + Math.random() * (maximum - minimum);
}

function randomSphere(radius: number): { position: Vec3; direction: Vec3 } {
    const selectedRadius = radius * (1 - Math.random());
    const phi = Math.random() * Math.PI * 2;
    const theta = Math.acos(2 * Math.random() - 1);
    const position = {
        x: selectedRadius * Math.cos(phi) * Math.sin(theta),
        y: selectedRadius * Math.cos(theta),
        z: selectedRadius * Math.sin(phi) * Math.sin(theta),
    };
    const inverse = 1 / Math.max(1e-8, Math.hypot(position.x, position.y, position.z));
    const direction = {
        x: position.x * inverse + Math.random(),
        y: position.y * inverse + Math.random(),
        z: position.z * inverse + Math.random(),
    };
    const directionInverse = 1 / Math.max(1e-8, Math.hypot(direction.x, direction.y, direction.z));
    direction.x *= directionInverse;
    direction.y *= directionInverse;
    direction.z *= directionInverse;
    return { position, direction };
}

function randomColor(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): [number, number, number, number] {
    const amount = Math.random();
    return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount, a[3] + (b[3] - a[3]) * amount];
}

function spawnCharge(effects: PlayroomEffects): void {
    if (effects.chargeParticles.length >= CHARGE_PARTICLES.capacity) {
        return;
    }
    const { position, direction } = randomSphere(CHARGE_PARTICLES.emitterRadius);
    effects.chargeParticles.push({
        x: effects.chargePoint.x + position.x,
        y: effects.chargePoint.y + position.y,
        z: effects.chargePoint.z + position.z,
        vx: direction.x,
        vy: direction.y,
        vz: direction.z,
        age: 0,
        life: randomBetween(CHARGE_PARTICLES.lifeMin, CHARGE_PARTICLES.lifeMax),
        size: randomBetween(CHARGE_PARTICLES.sizeMin, CHARGE_PARTICLES.sizeMax),
        rotation: 0,
        angularSpeed: 0,
        color: randomColor(CHARGE_PARTICLES.color1, CHARGE_PARTICLES.color2),
        kind: "charge",
    });
}

function spawnConfetti(effects: PlayroomEffects): void {
    if (effects.confettiParticles.length >= CONFETTI_PARTICLES.capacity) {
        return;
    }
    const h = 1 - Math.random() ** 2;
    const radius = CONFETTI_PARTICLES.radius * (1 - Math.random()) * h;
    const azimuth = Math.random() * Math.PI * 2;
    const local = { x: radius * Math.sin(azimuth), y: h * CONFETTI_PARTICLES.radius, z: radius * Math.cos(azimuth) };
    const inverse = 1 / Math.max(1e-8, Math.hypot(local.x, local.y, local.z));
    const power = randomBetween(CONFETTI_PARTICLES.powerMin, CONFETTI_PARTICLES.powerMax);
    effects.confettiParticles.push({
        x: effects.confettiPoint.x + local.x,
        y: effects.confettiPoint.y + local.y,
        z: effects.confettiPoint.z + local.z,
        vx: local.x * inverse * power,
        vy: local.y * inverse * power,
        vz: local.z * inverse * power,
        age: 0,
        life: CONFETTI_PARTICLES.life,
        size: CONFETTI_PARTICLES.size,
        rotation: 0,
        angularSpeed: randomBetween(CONFETTI_PARTICLES.angularSpeedMin, CONFETTI_PARTICLES.angularSpeedMax),
        color: randomColor(CONFETTI_PARTICLES.color1, CONFETTI_PARTICLES.color2),
        kind: "confetti",
    });
}

function updateParticles(particles: EffectParticle[], ratio: number): void {
    for (let index = particles.length - 1; index >= 0; index--) {
        const particle = particles[index]!;
        const speed = particle.kind === "score" ? SCORE_PARTICLES.updateSpeed : particle.kind === "charge" ? CHARGE_PARTICLES.updateSpeed : CONFETTI_PARTICLES.updateSpeed;
        const step = speed * ratio;
        particle.age += step;
        if (particle.age >= particle.life) {
            particles.splice(index, 1);
            continue;
        }
        const life = particle.age / particle.life;
        if (particle.kind === "score") {
            particle.color = [1, 1, 1, Math.min(2 - life * 2, 1)];
            particle.y += Math.pow(1.5 - life, 10) * 0.003 * GAME_SCALE * ratio;
        } else {
            if (particle.kind === "charge") {
                const velocity = CHARGE_PARTICLES.speedMin + (CHARGE_PARTICLES.speedMax - CHARGE_PARTICLES.speedMin) * life;
                particle.x += particle.vx * velocity * step;
                particle.y += particle.vy * velocity * step;
                particle.z += particle.vz * velocity * step;
                particle.color[0] += (CHARGE_PARTICLES.colorDead[0] - particle.color[0]) * step;
                particle.color[1] += (CHARGE_PARTICLES.colorDead[1] - particle.color[1]) * step;
                particle.color[2] += (CHARGE_PARTICLES.colorDead[2] - particle.color[2]) * step;
            } else {
                particle.vy += CONFETTI_PARTICLES.gravity * step;
                particle.x += particle.vx * step;
                particle.y += particle.vy * step;
                particle.z += particle.vz * step;
                particle.rotation += particle.angularSpeed * step;
            }
        }
    }
}

function syncSystem(system: FacingBillboardSpriteSystem, particles: readonly EffectParticle[], sprite: BillboardSpriteInit): void {
    clearBillboardSprites(system);
    for (const particle of particles) {
        sprite.position[0] = particle.x;
        sprite.position[1] = particle.y;
        sprite.position[2] = particle.z;
        sprite.sizeWorld[0] = particle.size;
        sprite.sizeWorld[1] = particle.size;
        sprite.color![0] = particle.color[0];
        sprite.color![1] = particle.color[1];
        sprite.color![2] = particle.color[2];
        sprite.color![3] = particle.color[3];
        sprite.rotation = particle.rotation;
        addBillboardSpriteIndex(system, sprite);
    }
}

export function updatePlayroomEffects(effects: PlayroomEffects, deltaMs: number, now = performance.now()): void {
    effects.aimingTimeSeconds += deltaMs * 0.001;
    if (effects.aimingTimeInput) {
        effects.aimingTimeInput.value = effects.aimingTimeSeconds;
    }
    const ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1;
    if (effects.chargeActive) {
        effects.chargeCarry += CHARGE_PARTICLES.emitRate * CHARGE_PARTICLES.updateSpeed * ratio;
        while (effects.chargeCarry >= 1) {
            spawnCharge(effects);
            effects.chargeCarry--;
        }
    }
    if (now < effects.confettiEmitUntil) {
        effects.confettiCarry += CONFETTI_PARTICLES.emitRate * CONFETTI_PARTICLES.updateSpeed * ratio;
        while (effects.confettiCarry >= 1) {
            spawnConfetti(effects);
            effects.confettiCarry--;
        }
    }
    updateParticles(effects.scoreParticles, ratio);
    updateParticles(effects.chargeParticles, ratio);
    updateParticles(effects.confettiParticles, ratio);
    syncSystem(effects.scoreSystem, effects.scoreParticles, effects.spriteScratch);
    syncSystem(effects.chargeSystem, effects.chargeParticles, effects.spriteScratch);
    syncSystem(effects.confettiSystem, effects.confettiParticles, effects.spriteScratch);
}

export function showScoreStar(effects: PlayroomEffects, point: Vec3): void {
    if (effects.scoreParticles.length >= SCORE_PARTICLES.capacity) {
        return;
    }
    effects.scoreParticles.push({
        x: point.x + (Math.random() - 0.5) * GAME_SCALE * 4,
        y: point.y + (Math.random() - 0.5) * GAME_SCALE,
        z: point.z + (Math.random() - 0.5) * GAME_SCALE * 4,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        life: randomBetween(SCORE_PARTICLES.lifeMin, SCORE_PARTICLES.lifeMax),
        size: SCORE_PARTICLES.size,
        rotation: 0,
        angularSpeed: 0,
        color: [1, 1, 1, 1],
        kind: "score",
    });
}

export function showConfetti(effects: PlayroomEffects, point: Vec3, now = performance.now()): void {
    effects.confettiPoint = { x: point.x, y: point.y, z: point.z };
    for (let index = 0; index < CONFETTI_PARTICLES.manualEmitCount; index++) {
        spawnConfetti(effects);
    }
    effects.confettiEmitUntil = now + CONFETTI_PARTICLES.emitDurationMs;
}

export function setChargeEffect(effects: PlayroomEffects, active: boolean, point?: Vec3): void {
    effects.chargeActive = active;
    if (point) {
        effects.chargePoint = { x: point.x, y: point.y, z: point.z };
    }
    if (!active) {
        effects.chargeCarry = 0;
    }
}

export function resetPlayroomEffects(effects: PlayroomEffects): void {
    effects.scoreParticles.length = 0;
    effects.chargeParticles.length = 0;
    effects.confettiParticles.length = 0;
    effects.chargeActive = false;
    effects.chargeCarry = 0;
    effects.confettiCarry = 0;
    effects.confettiEmitUntil = 0;
    clearBillboardSprites(effects.scoreSystem);
    clearBillboardSprites(effects.chargeSystem);
    clearBillboardSprites(effects.confettiSystem);
}
