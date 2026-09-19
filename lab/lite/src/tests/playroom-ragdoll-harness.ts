import HavokPhysics from "@babylonjs/havok";
import {
    createEngine,
    createHavokWorld,
    createSceneContext,
    disposeEngine,
    disposePhysics,
    enableHavokThinInstancePhysics,
    getPhysicsBodyAngularVelocity,
    getPhysicsBodyLinearVelocity,
    onPhysicsCollision,
    PhysicsMotionType,
    PhysicsPrestepType,
    setPhysicsBodyCollisionEventsEnabled,
} from "babylon-lite";
import type { Mesh, PhysicsBody, PhysicsWorld, SceneContext, SceneNode } from "babylon-lite";
import { resetGameplayCounters } from "../demos/playroom/game.js";
import { loadPlayroomAssets } from "../demos/playroom/assets.js";
import { createBunnyRagdoll, currentColliderOffsetWorld, installBunnyPoseSync, launchBunny, relocateBunny } from "../demos/playroom/ragdoll.js";
import type { PlayroomAssets, RagdollState } from "../demos/playroom/types.js";
import { buildPlayroomWorld } from "../demos/playroom/world.js";

interface Pose {
    position: number[];
    rotation: number[];
}

interface RagdollHarnessSnapshot {
    readonly schemaVersion: 1;
    readonly sourceRevision: string;
    readonly counts: { bodies: number; constraints: number };
    readonly initial: {
        frames: number;
        groundContactCount: number;
        allDynamicBeforePlay: boolean;
        rootStartY: number;
        rootSettledY: number;
        maxLinearSpeed: number;
        maxAngularSpeed: number;
        allBodiesTranslationSettled: boolean;
        skeletonMatchesPhysics: boolean;
    };
    readonly launches: {
        forceCount: number;
        forceMagnitudes: number[];
        allDynamicBeforeForce: boolean[];
        doubleKickGuarded: boolean;
        currentPoseRetained: boolean[];
        noTeleportOnKick: boolean[];
        forceAppliedAtCurrentRoot: boolean[];
        nextStartedDynamic: boolean[];
        nextSettledOnGround: boolean[];
        nextMaxLinearSpeeds: number[];
        nextMaxAngularSpeeds: number[];
        replayStartedDynamic: boolean;
        replaySettledOnGround: boolean;
        replayMaxLinearSpeed: number;
        replayMaxAngularSpeed: number;
        scoreReset: boolean;
        skeletonMatchesPhysics: boolean[];
    };
    readonly stableIdentities: { bodies: boolean; constraints: boolean };
}

function id(handle: unknown): string {
    return String((handle as ArrayLike<unknown>)[0]);
}

function pose(body: PhysicsBody): Pose {
    const node = body.node;
    return {
        position: [node.position.x, node.position.y, node.position.z],
        rotation: [node.rotationQuaternion.x, node.rotationQuaternion.y, node.rotationQuaternion.z, node.rotationQuaternion.w],
    };
}

function closeNumbers(actual: readonly number[], expected: readonly number[], epsilon = 1e-5): boolean {
    return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= epsilon);
}

function posesMatch(actual: readonly Pose[], expected: readonly Pose[]): boolean {
    return (
        actual.length === expected.length &&
        actual.every((value, index) => closeNumbers(value.position, expected[index]!.position) && closeNumbers(value.rotation, expected[index]!.rotation))
    );
}

function capturePoses(ragdoll: RagdollState): Pose[] {
    return ragdoll.records.map((record) => pose(record.body));
}

function step(scene: SceneContext, frames = 1): void {
    for (let frame = 0; frame < frames; frame++) {
        scene._beforeRender[0]!(1000 / 60);
    }
}

function bodySpeeds(physics: PhysicsWorld, ragdoll: RagdollState): { maxLinear: number; maxAngular: number } {
    let maxLinear = 0;
    let maxAngular = 0;
    for (const record of ragdoll.records) {
        const linear = getPhysicsBodyLinearVelocity(physics, record.body);
        const angular = getPhysicsBodyAngularVelocity(physics, record.body);
        maxLinear = Math.max(maxLinear, Math.hypot(linear.x, linear.y, linear.z));
        maxAngular = Math.max(maxAngular, Math.hypot(angular.x, angular.y, angular.z));
    }
    return { maxLinear, maxAngular };
}

function findSkinnedMesh(node: SceneNode): Mesh | null {
    if ("skeleton" in node && node.skeleton) {
        return node as Mesh;
    }
    for (const child of node.children) {
        const match = findSkinnedMesh(child);
        if (match) {
            return match;
        }
    }
    return null;
}

function inverseAffinePoint(matrix: ArrayLike<number>, point: readonly number[]): number[] {
    const a00 = matrix[0]!;
    const a01 = matrix[4]!;
    const a02 = matrix[8]!;
    const a10 = matrix[1]!;
    const a11 = matrix[5]!;
    const a12 = matrix[9]!;
    const a20 = matrix[2]!;
    const a21 = matrix[6]!;
    const a22 = matrix[10]!;
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    const inverseDeterminant = 1 / (a00 * b01 + a01 * b11 + a02 * b21);
    const x = point[0]! - matrix[12]!;
    const y = point[1]! - matrix[13]!;
    const z = point[2]! - matrix[14]!;
    return [
        (b01 * x + (-a22 * a01 + a02 * a21) * y + (a12 * a01 - a02 * a11) * z) * inverseDeterminant,
        (b11 * x + (a22 * a00 - a02 * a20) * y + (-a12 * a00 + a02 * a10) * z) * inverseDeterminant,
        (b21 * x + (-a21 * a00 + a01 * a20) * y + (a11 * a00 - a01 * a10) * z) * inverseDeterminant,
    ];
}

function transformPoint(matrix: ArrayLike<number>, point: readonly number[]): number[] {
    return [
        matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
        matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
        matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!,
    ];
}

function skeletonPaletteMatchesPhysics(assets: PlayroomAssets, ragdoll: RagdollState): boolean {
    const mesh = findSkinnedMesh(ragdoll.visualRoot);
    if (!mesh?.skeleton) {
        return false;
    }
    return assets.rig.joints.every((joint, recordIndex) => {
        const boneIndex = assets.bunnySkeleton.bones.findIndex((candidate) => candidate.name === joint.name);
        if (boneIndex < 0) {
            return false;
        }
        const sourceBindPoint = inverseAffinePoint(mesh.worldMatrix, [-joint.bindWorldPosition[0], joint.bindWorldPosition[1], joint.bindWorldPosition[2]]);
        const palettePoint = transformPoint(mesh.skeleton!.boneMatrices.subarray(boneIndex * 16, boneIndex * 16 + 16), sourceBindPoint);
        const renderedJoint = transformPoint(mesh.worldMatrix, palettePoint);
        const record = ragdoll.records[recordIndex]!;
        const colliderOffset = currentColliderOffsetWorld(joint, record.mesh.rotationQuaternion);
        return closeNumbers(renderedJoint, [record.mesh.position.x - colliderOffset.x, record.mesh.position.y - colliderOffset.y, record.mesh.position.z - colliderOffset.z], 1e-4);
    });
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const hknp = await HavokPhysics({ locateFile: () => new URL("/HavokPhysics.wasm", window.location.href).href });
    const rawApplyImpulse = hknp.HP_Body_ApplyImpulse.bind(hknp);
    const rawSetMotionType = hknp.HP_Body_SetMotionType.bind(hknp);
    const rawSetTransform = hknp.HP_Body_SetQTransform.bind(hknp);
    type NativeBody = Parameters<typeof hknp.HP_Body_SetMotionType>[0];
    type NativePoint = Parameters<typeof hknp.HP_Body_ApplyImpulse>[1];
    type NativeImpulse = Parameters<typeof hknp.HP_Body_ApplyImpulse>[2];
    type NativeTransform = Parameters<typeof hknp.HP_Body_SetQTransform>[1];
    const forceMagnitudes: number[] = [];
    const forcePoints: number[][] = [];
    let motionSetCount = 0;
    let transformSetCount = 0;
    let rootNativeId = "";
    hknp.HP_Body_SetMotionType = (body: NativeBody, motionType: number) => {
        motionSetCount++;
        return rawSetMotionType(body, motionType);
    };
    hknp.HP_Body_SetQTransform = (body: NativeBody, transform: NativeTransform) => {
        transformSetCount++;
        return rawSetTransform(body, transform);
    };
    hknp.HP_Body_ApplyImpulse = (body: NativeBody, point: NativePoint, impulse: NativeImpulse) => {
        if (id(body) === rootNativeId) {
            forceMagnitudes.push(Math.hypot(...impulse) * 60);
            forcePoints.push(Array.from(point));
        }
        return rawApplyImpulse(body, point, impulse);
    };
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / 60;
    const assets = await loadPlayroomAssets(engine, new URL("/playroom-oracle-entry.js", window.location.href).href);
    const physics = createHavokWorld(scene, hknp, { x: 0, y: -9.81, z: 0 });
    await enableHavokThinInstancePhysics(physics);
    const world = buildPlayroomWorld(engine, scene, physics, assets);
    const ragdoll = createBunnyRagdoll(scene, physics, assets, world, { x: 0, y: 0.9, z: 0 });
    installBunnyPoseSync(
        physics,
        assets,
        () => ragdoll,
        () => false
    );
    rootNativeId = id(ragdoll.root.body._hkBody);
    const bodyIds = ragdoll.records.map((record) => id(record.body._hkBody));
    const constraintIds = ragdoll.constraints.map((constraint) => id(constraint._hkConstraint));
    const ground = world.records.find((record) => record.family === "ground")!;
    let groundContactCount = 0;
    setPhysicsBodyCollisionEventsEnabled(physics, ground.body, true);
    for (const record of ragdoll.records) {
        setPhysicsBodyCollisionEventsEnabled(physics, record.body, true);
    }
    onPhysicsCollision(physics, (info) => {
        const collider = world.bodiesByObject.get(info.collider);
        const collidedAgainst = world.bodiesByObject.get(info.collidedAgainst);
        if (
            info.type !== "FINISHED" &&
            ((collider?.family === "ground" && collidedAgainst?.family === "ragdoll") || (collider?.family === "ragdoll" && collidedAgainst?.family === "ground"))
        ) {
            groundContactCount++;
        }
    });
    const rootStartY = ragdoll.root.mesh.position.y;
    const allDynamicBeforePlay = ragdoll.records.every(
        (record) => record.body.motionType === PhysicsMotionType.DYNAMIC && record.body._prestepType === PhysicsPrestepType.DISABLED
    );
    step(scene, 300);
    const initialSpeeds = bodySpeeds(physics, ragdoll);
    const initial = {
        frames: 300,
        groundContactCount,
        allDynamicBeforePlay,
        rootStartY,
        rootSettledY: ragdoll.root.mesh.position.y,
        maxLinearSpeed: initialSpeeds.maxLinear,
        maxAngularSpeed: initialSpeeds.maxAngular,
        allBodiesTranslationSettled: initialSpeeds.maxLinear < 0.15,
        skeletonMatchesPhysics: skeletonPaletteMatchesPhysics(assets, ragdoll),
    };

    const allDynamicBeforeForce: boolean[] = [];
    const currentPoseRetained: boolean[] = [];
    const noTeleportOnKick: boolean[] = [];
    const forceAppliedAtCurrentRoot: boolean[] = [];
    const skeletonMatchesPhysics = [initial.skeletonMatchesPhysics];
    let doubleKickGuarded = true;
    const launchFromSettledPose = (): void => {
        const before = capturePoses(ragdoll);
        const currentRoot = before[ragdoll.records.indexOf(ragdoll.root)]!.position;
        const transformsBefore = transformSetCount;
        const motionsBefore = motionSetCount;
        const forcesBefore = forceMagnitudes.length;
        allDynamicBeforeForce.push(
            ragdoll.records.every((record) => record.body.motionType === PhysicsMotionType.DYNAMIC && record.body._prestepType === PhysicsPrestepType.DISABLED)
        );
        launchBunny(physics, ragdoll, { x: 1, y: 0, z: 0 });
        const forcesAfterFirstKick = forceMagnitudes.length;
        launchBunny(physics, ragdoll, { x: 1, y: 0, z: 0 });
        doubleKickGuarded &&= forcesAfterFirstKick === forcesBefore + 1 && forceMagnitudes.length === forcesAfterFirstKick;
        currentPoseRetained.push(posesMatch(capturePoses(ragdoll), before));
        noTeleportOnKick.push(transformSetCount === transformsBefore && motionSetCount === motionsBefore);
        forceAppliedAtCurrentRoot.push(closeNumbers(forcePoints[forcesBefore]!, currentRoot));
        step(scene);
    };

    launchFromSettledPose();

    const nextStartedDynamic: boolean[] = [];
    const nextSettledOnGround: boolean[] = [];
    const nextMaxLinearSpeeds: number[] = [];
    const nextMaxAngularSpeeds: number[] = [];
    for (let throwIndex = 1; throwIndex < 3; throwIndex++) {
        const contactsBefore = groundContactCount;
        relocateBunny(physics, ragdoll, { x: 0, y: 1, z: 0 });
        nextStartedDynamic.push(
            ragdoll.records.every((record) => record.body.motionType === PhysicsMotionType.DYNAMIC && record.body._prestepType === PhysicsPrestepType.DISABLED)
        );
        step(scene, 300);
        const speeds = bodySpeeds(physics, ragdoll);
        nextMaxLinearSpeeds.push(speeds.maxLinear);
        nextMaxAngularSpeeds.push(speeds.maxAngular);
        nextSettledOnGround.push(groundContactCount > contactsBefore && speeds.maxLinear < 0.15);
        skeletonMatchesPhysics.push(skeletonPaletteMatchesPhysics(assets, ragdoll));
        launchFromSettledPose();
    }

    const replayContactsBefore = groundContactCount;
    relocateBunny(physics, ragdoll, { x: 0, y: 1, z: 0 });
    const replayStartedDynamic = ragdoll.records.every(
        (record) => record.body.motionType === PhysicsMotionType.DYNAMIC && record.body._prestepType === PhysicsPrestepType.DISABLED
    );
    step(scene, 300);
    const replaySpeeds = bodySpeeds(physics, ragdoll);
    const replaySettledOnGround = groundContactCount > replayContactsBefore && replaySpeeds.maxLinear < 0.15;
    skeletonMatchesPhysics.push(skeletonPaletteMatchesPhysics(assets, ragdoll));
    const counters = { throwCount: 3, score: 91, scorePaused: false, scorePausedBeforeFree: false, poppersArmed: true, settlingFrames: 7 };
    resetGameplayCounters(counters);

    const snapshot: RagdollHarnessSnapshot = {
        schemaVersion: 1,
        sourceRevision: "d22ce23ef308e28d1f8b6598b4c72ea944205925",
        counts: { bodies: ragdoll.records.length, constraints: ragdoll.constraints.length },
        initial,
        launches: {
            forceCount: forceMagnitudes.length,
            forceMagnitudes,
            allDynamicBeforeForce,
            doubleKickGuarded,
            currentPoseRetained,
            noTeleportOnKick,
            forceAppliedAtCurrentRoot,
            nextStartedDynamic,
            nextSettledOnGround,
            nextMaxLinearSpeeds,
            nextMaxAngularSpeeds,
            replayStartedDynamic,
            replaySettledOnGround,
            replayMaxLinearSpeed: replaySpeeds.maxLinear,
            replayMaxAngularSpeed: replaySpeeds.maxAngular,
            scoreReset:
                counters.throwCount === 1 &&
                counters.score === 0 &&
                counters.scorePaused &&
                counters.scorePausedBeforeFree &&
                !counters.poppersArmed &&
                counters.settlingFrames === 0,
            skeletonMatchesPhysics,
        },
        stableIdentities: {
            bodies: closeNumbers(
                ragdoll.records.map((record) => Number(id(record.body._hkBody))),
                bodyIds.map(Number),
                0
            ),
            constraints: closeNumbers(
                ragdoll.constraints.map((constraint) => Number(id(constraint._hkConstraint))),
                constraintIds.map(Number),
                0
            ),
        },
    };
    const output = document.createElement("script");
    output.id = "playroom-ragdoll-snapshot";
    output.type = "application/json";
    output.textContent = JSON.stringify(snapshot);
    document.body.append(output);
    canvas.dataset.ready = "true";
    window.addEventListener(
        "pagehide",
        () => {
            disposePhysics(physics);
            disposeEngine(engine);
        },
        { once: true }
    );
}

void main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
