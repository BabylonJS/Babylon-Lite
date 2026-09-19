import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createDirectionalLight,
    createEngine,
    createHavokWorld,
    createHemisphericLight,
    createPcfDirectionalShadowGenerator,
    createSceneContext,
    enableHavokThinInstancePhysics,
    loadEnvironment,
    loadSkybox,
    registerSceneWithShadowSupport,
    removePhysicsBody,
    setGpuTimingEnabled,
    setPhysicsBodyTransform,
    setPhysicsTimestepMs,
    setShadowTaskCasterMeshes,
    setThinInstanceCount,
    startEngine,
} from "babylon-lite";
import type { EngineContext, PhysicsWorld, RenderTask, Task, Vec3 } from "babylon-lite";
import { createPlayroomAudio } from "../demos/playroom/audio.js";
import { loadPlayroomAssets } from "../demos/playroom/assets.js";
import { createPlayroomCameras } from "../demos/playroom/camera.js";
import { createPlayroomEffects, resetPlayroomEffects } from "../demos/playroom/effects.js";
import type { PlayroomEffects } from "../demos/playroom/effects.js";
import { createPlayroomGame, disposePlayroomGame, resetPlayroomGame } from "../demos/playroom/game.js";
import { applyRadialExplosion } from "../demos/playroom/physics.js";
import type { BodyRecord, PlayroomState, WorldState } from "../demos/playroom/types.js";
import { buildPlayroomWorld } from "../demos/playroom/world.js";
import { demoAssetUrl } from "../demos/demo-asset-url.js";
import { liveCount, summarizeSamples } from "./playroom-lifecycle-metrics.js";

const SOURCE_REVISION = "d22ce23ef308e28d1f8b6598b4c72ea944205925";
const MAX_SAMPLES = 10_000;

interface NativeCounters {
    bodyCreates: number;
    bodyReleases: number;
    shapeCreates: number;
    shapeReleases: number;
    constraintCreates: number;
    constraintReleases: number;
    worldSteps: number;
    transformPolls: number;
    linearVelocityReads: number;
    angularVelocityReads: number;
    collisionDrains: number;
    collisionNextCalls: number;
    collisionEvents: Record<"STARTED" | "CONTINUED" | "FINISHED", number>;
}

interface ResolutionCounters {
    calls: number;
    successes: number;
    misses: number;
    thinLinearScans: number;
    elapsedMs: number;
}

interface GpuWriteCounters {
    calls: number;
    sourceBytes: number;
}

interface HavokRaw {
    [name: string]: unknown;
    readonly HEAPU8: Uint8Array;
    readonly EventType: {
        readonly COLLISION_STARTED: { readonly value: unknown };
        readonly COLLISION_CONTINUED: { readonly value: unknown };
    };
    HP_World_GetCollisionEvents: (...args: unknown[]) => ArrayLike<unknown>;
    HP_World_GetNextCollisionEvent: (...args: unknown[]) => unknown;
}

const native: NativeCounters = {
    bodyCreates: 0,
    bodyReleases: 0,
    shapeCreates: 0,
    shapeReleases: 0,
    constraintCreates: 0,
    constraintReleases: 0,
    worldSteps: 0,
    transformPolls: 0,
    linearVelocityReads: 0,
    angularVelocityReads: 0,
    collisionDrains: 0,
    collisionNextCalls: 0,
    collisionEvents: { STARTED: 0, CONTINUED: 0, FINISHED: 0 },
};
const resolutions: ResolutionCounters = { calls: 0, successes: 0, misses: 0, thinLinearScans: 0, elapsedMs: 0 };
const gpuWrites: GpuWriteCounters = { calls: 0, sourceBytes: 0 };
const frameWallMs: number[] = [];
const frameJsMs: number[] = [];
const frameGpuMs: number[] = [];
let renderedFrames = 0;
let descriptorRebuilds = 0;
let lastFrameAt = 0;
let readyNativeSteps = 0;
let readyGpuWriteCalls = 0;
let readyGpuWriteBytes = 0;
let readyDescriptorRebuilds = 0;
let popperEvents = 0;

function incrementWrapped(raw: HavokRaw, name: string, increment: () => void): void {
    const candidate = raw[name];
    if (typeof candidate !== "function") {
        throw new Error(`Lifecycle instrumentation requires Havok ${name}.`);
    }
    const original = candidate.bind(raw) as (...args: unknown[]) => unknown;
    raw[name] = (...args: unknown[]) => {
        increment();
        return original(...args);
    };
}

function installNativeObserver(raw: HavokRaw): void {
    incrementWrapped(raw, "HP_Body_Create", () => native.bodyCreates++);
    incrementWrapped(raw, "HP_Body_Release", () => native.bodyReleases++);
    incrementWrapped(raw, "HP_Constraint_Create", () => native.constraintCreates++);
    incrementWrapped(raw, "HP_Constraint_Release", () => native.constraintReleases++);
    incrementWrapped(raw, "HP_World_Step", () => native.worldSteps++);
    incrementWrapped(raw, "HP_Body_GetQTransform", () => native.transformPolls++);
    incrementWrapped(raw, "HP_Body_GetLinearVelocity", () => native.linearVelocityReads++);
    incrementWrapped(raw, "HP_Body_GetAngularVelocity", () => native.angularVelocityReads++);

    const shapeCreates = [
        "HP_Shape_CreateBox",
        "HP_Shape_CreateSphere",
        "HP_Shape_CreateCapsule",
        "HP_Shape_CreateCylinder",
        "HP_Shape_CreateContainer",
        "HP_Shape_CreateConvexHull",
        "HP_Shape_CreateMesh",
    ];
    for (const name of shapeCreates) {
        incrementWrapped(raw, name, () => native.shapeCreates++);
    }
    incrementWrapped(raw, "HP_Shape_Release", () => native.shapeReleases++);

    const started = Number(raw.EventType.COLLISION_STARTED.value);
    const continued = Number(raw.EventType.COLLISION_CONTINUED.value);
    const recordEvent = (address: unknown): void => {
        const numericAddress = Number(address);
        if (!numericAddress) {
            return;
        }
        const type = new Int32Array(raw.HEAPU8.buffer, numericAddress)[0];
        native.collisionEvents[type === started ? "STARTED" : type === continued ? "CONTINUED" : "FINISHED"]++;
    };
    const getEvents = raw.HP_World_GetCollisionEvents.bind(raw);
    raw.HP_World_GetCollisionEvents = (...args: unknown[]) => {
        native.collisionDrains++;
        const result = getEvents(...args);
        recordEvent(result[1]);
        return result;
    };
    const getNext = raw.HP_World_GetNextCollisionEvent.bind(raw);
    raw.HP_World_GetNextCollisionEvent = (...args: unknown[]) => {
        native.collisionNextCalls++;
        const result = getNext(...args);
        recordEvent(result);
        return result;
    };
}

function dataBytes(value: ArrayBuffer | ArrayBufferView): number {
    return value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
}

function installGpuWriteObserver(engine: EngineContext): void {
    const queue = engine._device.queue as GPUQueue & { writeBuffer: GPUQueue["writeBuffer"] };
    const original = queue.writeBuffer.bind(queue);
    Object.defineProperty(queue, "writeBuffer", {
        configurable: true,
        value: (buffer: GPUBuffer, bufferOffset: GPUSize64, data: AllowSharedBufferSource, dataOffset?: GPUSize64, size?: GPUSize64): void => {
            gpuWrites.calls++;
            gpuWrites.sourceBytes += Number(size ?? dataBytes(data as ArrayBuffer | ArrayBufferView));
            original(buffer, bufferOffset, data, dataOffset, size);
        },
    });
}

function installResolutionObserver(world: PhysicsWorld): () => void {
    const context = world._events;
    if (!context || !world._thin) {
        throw new Error("Collision and thin-instance event contexts must be installed before lifecycle observation.");
    }
    const original = context.resolve.bind(context);
    const thinResolve = world._thin.resolve.bind(world._thin);
    world._thin.resolve = (id: unknown) => {
        resolutions.thinLinearScans++;
        return thinResolve(id);
    };
    context.resolve = (id: unknown) => {
        const startedAt = performance.now();
        resolutions.calls++;
        const result = original(id);
        resolutions.elapsedMs += performance.now() - startedAt;
        if (result) {
            resolutions.successes++;
        } else {
            resolutions.misses++;
        }
        return result;
    };
    return (): void => {};
}

function installFrameObserver(engine: EngineContext, state: PlayroomState, effects: PlayroomEffects): void {
    state.scene._beforeRender.unshift(() => {
        const startedAt = performance.now();
        if (lastFrameAt) {
            if (frameWallMs.length < MAX_SAMPLES) {
                frameWallMs.push(startedAt - lastFrameAt);
            }
        }
        lastFrameAt = startedAt;
        queueMicrotask(() => {
            renderedFrames++;
            descriptorRebuilds += effects.scoreParticles.length + effects.chargeParticles.length + effects.confettiParticles.length;
            if (frameJsMs.length < MAX_SAMPLES) {
                frameJsMs.push(performance.now() - startedAt);
                if (engine.gpuFrameTimeMs > 0) {
                    frameGpuMs.push(engine.gpuFrameTimeMs);
                }
            }
        });
    });
}

function bodyPosition(record: BodyRecord): Vec3 {
    const mesh = record.mesh as BodyRecord["mesh"] & { thinInstances?: { matrices: Float32Array } };
    const matrices = mesh.thinInstances?.matrices;
    return matrices ? { x: matrices[12]!, y: matrices[13]!, z: matrices[14]! } : mesh.position;
}

function activeInstanceCount(world: WorldState): number {
    let count = 0;
    for (const record of world.records) {
        const mesh = record.mesh as BodyRecord["mesh"] & { thinInstances?: { count: number } };
        count += mesh.thinInstances?.count ?? 1;
    }
    return count;
}

function retirementCallbackCount(engine: EngineContext): number {
    let count = 0;
    for (const batch of engine._retiring ?? []) {
        count += batch.length;
    }
    return count;
}

function isRenderTask(task: Task): task is RenderTask {
    return "_renderables" in task;
}

function auxiliaryDisposerOwnerCount(state: PlayroomState): number {
    let count = 0;
    for (const task of state.scene._frameGraph._tasks) {
        if (isRenderTask(task)) {
            for (const renderable of task._renderables) {
                count += renderable._lifetimeDisposers ? 1 : 0;
            }
        }
    }
    return count;
}

function report(state: PlayroomState, effects: PlayroomEffects, mode: string): object {
    const engine = state.engine;
    const eventCount = native.collisionEvents.STARTED + native.collisionEvents.CONTINUED + native.collisionEvents.FINISHED;
    const nodeOutputs = [...state.scene._groups].filter(([builder]) => builder._materialFamily === "node").flatMap(([, group]) => group.o ?? []);
    return {
        schemaVersion: 1,
        sourceRevision: SOURCE_REVISION,
        mode,
        phase: state.phase,
        throwCount: state.throwCount,
        frames: {
            rendered: renderedFrames,
            wallMs: summarizeSamples(frameWallMs),
            javascriptMs: summarizeSamples(frameJsMs),
            gpuMs: summarizeSamples(frameGpuMs),
            fixedPhysicsSteps: native.worldSteps - readyNativeSteps,
        },
        contacts: {
            ...native.collisionEvents,
            events: eventCount,
            drains: native.collisionDrains,
            nextCalls: native.collisionNextCalls,
            activeAfterStepSubscribers: state.physics._afterStep?.length ?? 0,
            resolutions: { ...resolutions },
        },
        native: {
            bodies: { created: native.bodyCreates, released: native.bodyReleases, live: liveCount(native.bodyCreates, native.bodyReleases) },
            shapes: { created: native.shapeCreates, released: native.shapeReleases, live: liveCount(native.shapeCreates, native.shapeReleases) },
            constraints: {
                created: native.constraintCreates,
                released: native.constraintReleases,
                live: liveCount(native.constraintCreates, native.constraintReleases),
            },
            logicalRecords: state.world.records.length,
            activeInstances: activeInstanceCount(state.world),
            transformPolls: native.transformPolls,
            linearVelocityReads: native.linearVelocityReads,
            angularVelocityReads: native.angularVelocityReads,
        },
        gpuWrites: {
            calls: gpuWrites.calls - readyGpuWriteCalls,
            sourceBytes: gpuWrites.sourceBytes - readyGpuWriteBytes,
            pendingRetirements: engine._retirements?.length ?? 0,
            retiringBatches: engine._retiring?.size ?? 0,
            retiringCallbacks: retirementCallbackCount(engine),
        },
        effects: {
            score: effects.scoreParticles.length,
            charge: effects.chargeParticles.length,
            confetti: effects.confettiParticles.length,
            descriptorRebuilds: descriptorRebuilds - readyDescriptorRebuilds,
            popperEvents,
        },
        audio: {
            status: state.audio.status,
            voices: state.audio.voices.size,
            pairTimes: state.audio.contactPairTimes.size,
            profileTimes: state.audio.contactLastPlayMs.size,
            poolIndices: state.audio.contactPoolIndices.size,
        },
        lifecycle: {
            retiredWorlds: state.retiredWorlds.length,
            retirementFrames: state.retiredWorlds.map((retired) => retired.frames),
            timers: state.timers.size,
            sceneMeshes: state.scene.meshes.length,
            renderables: state.scene._renderables.length,
            groupRenderables: [...state.scene._groups.values()].reduce((count, group) => count + (group.o?.length ?? 0), 0),
            nodeRenderables: nodeOutputs.filter((renderable) => state.scene._renderables.includes(renderable)).length,
            nodeGroupRenderables: nodeOutputs.length,
            meshDisposerOwners: state.scene._meshDisposables.size,
            auxDisposerOwners: auxiliaryDisposerOwnerCount(state),
        },
    };
}

function waitFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
        let remaining = count;
        const next = (): void => {
            if (--remaining <= 0) {
                resolve();
            } else {
                requestAnimationFrame(next);
            }
        };
        requestAnimationFrame(next);
    });
}

function click(id: string): void {
    const button = document.getElementById(id);
    if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`Missing lifecycle control #${id}.`);
    }
    button.click();
}

async function completeThrow(state: PlayroomState): Promise<void> {
    click("playroom-kick");
    await waitFrames(5);
    const root = state.ragdoll.root.mesh;
    setPhysicsBodyTransform(state.physics, state.ragdoll.root.body, { x: 17, y: 2, z: 0 }, root.rotationQuaternion);
    await waitFrames(3);
}

function explodePoppers(state: PlayroomState, count: number): number {
    let explosions = 0;
    for (const record of state.world.poppers) {
        if (explosions >= count || !state.world.bodiesByObject.has(record.body)) {
            continue;
        }
        applyRadialExplosion(state.physics, state.world, record, record.popperIndex === 0 || record.popperIndex === 2);
        const point = bodyPosition(record);
        record.scored.add(-1);
        record.mesh.visible = false;
        if ("thinInstances" in record.mesh && record.mesh.thinInstances) {
            setThinInstanceCount(record.mesh, 0);
        }
        state.world.bodiesByObject.delete(record.body);
        removePhysicsBody(state.physics, record.body);
        document.dispatchEvent(new CustomEvent("playroom-popper", { detail: { point } }));
        explosions++;
    }
    return explosions;
}

async function runFullWorkload(state: PlayroomState, effects: PlayroomEffects, rebuildResolutionMap: () => void, removeEffects: boolean, mode: string): Promise<object> {
    const stages: Array<{ name: string; snapshot: object }> = [];
    await waitFrames(30);
    stages.push({ name: "idle", snapshot: report(state, effects, mode) });

    click("playroom-startup-action");
    await completeThrow(state);
    stages.push({ name: "first-launch", snapshot: report(state, effects, mode) });

    const firstExplosions = explodePoppers(state, 1);
    await waitFrames(10);
    const remainingExplosions = explodePoppers(state, state.world.poppers.length);
    if (removeEffects) {
        resetPlayroomEffects(effects);
    }
    await waitFrames(30);
    stages.push({ name: "maximum-explosions", snapshot: report(state, effects, mode) });
    const maximumPopperEvents = popperEvents;

    await waitFrames(120);
    stages.push({ name: "quiet", snapshot: report(state, effects, mode) });

    resetPlayroomGame(state, effects);
    rebuildResolutionMap();
    for (let throwIndex = 0; throwIndex < 3; throwIndex++) {
        await completeThrow(state);
        if (throwIndex < 2) {
            click("playroom-next");
            await waitFrames(2);
        }
    }
    stages.push({ name: "three-throws", snapshot: report(state, effects, mode) });

    click("playroom-replay");
    rebuildResolutionMap();
    await waitFrames(130);
    stages.push({ name: "first-replay-retired", snapshot: report(state, effects, mode) });
    resetPlayroomGame(state, effects);
    rebuildResolutionMap();
    resetPlayroomGame(state, effects);
    rebuildResolutionMap();
    await waitFrames(3);
    stages.push({ name: "replay-burst", snapshot: report(state, effects, mode) });
    await waitFrames(130);
    stages.push({ name: "post-retirement", snapshot: report(state, effects, mode) });

    return {
        schemaVersion: 1,
        sourceRevision: SOURCE_REVISION,
        mode,
        workload: { firstExplosions, remainingExplosions, maximumPopperEvents, completedThrows: 3, replayCount: 3 },
        stages,
        final: report(state, effects, mode),
    };
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Missing #renderCanvas.");
    }
    const params = new URLSearchParams(location.search);
    const removeEffects = params.get("effects") === "off";
    const mode = removeEffects ? "effects-removed" : "normal";
    const assetEntry = new URL("/playroom-oracle-entry.js", location.href).href;
    const asset = (relative: string): string => demoAssetUrl(`./playroom/${relative}`, assetEntry);

    const engine = await createEngine(canvas);
    installGpuWriteObserver(engine);
    setGpuTimingEnabled(engine, true);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / 60;
    scene.clearColor = { r: 0.18, g: 0.18, b: 0.2, a: 1 };
    const cameras = createPlayroomCameras(scene, canvas);
    const sun = createDirectionalLight([0, -2, -2], 0.85);
    sun.position.set(0, 12, 0);
    addToScene(scene, sun);
    addToScene(scene, createHemisphericLight([0, 1, 0.5], 0.1));
    const shadow = createPcfDirectionalShadowGenerator(engine, sun, {
        mapSize: 2048,
        bias: 0.0001,
        orthoMinZ: -6,
        orthoMaxZ: 30,
        forceRefreshEveryFrame: true,
    });
    sun.shadowGenerator = shadow;
    await loadEnvironment(scene, asset("env/childRoom_ibl.env"), {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: demoAssetUrl("./brdf-lut.png", assetEntry),
    });
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;
    await loadSkybox(scene, asset("env/skybox/childRoom_1K"), ".jpg", 70);
    const assets = await loadPlayroomAssets(engine, assetEntry, [shadow]);
    const hknp = await HavokPhysics({ locateFile: () => demoAssetUrl("./HavokPhysics.wasm", assetEntry) });
    installNativeObserver(hknp as unknown as HavokRaw);
    const physics = createHavokWorld(scene, hknp, { x: 0, y: -9.81, z: 0 });
    setPhysicsTimestepMs(physics, 1000 / 60);
    await enableHavokThinInstancePhysics(physics);
    const world = buildPlayroomWorld(engine, scene, physics, assets);
    const effects = createPlayroomEffects(engine, scene, assets);
    const audio = await createPlayroomAudio((file) => asset(`sounds/${file}`));
    const state = createPlayroomGame({
        canvas,
        engine,
        scene,
        physics,
        assets,
        camera: cameras.orbit,
        freeCamera: cameras.free,
        world,
        audio,
        effects,
        shadow,
        setCameraMode: cameras.setMode,
        disposeCameras: cameras.dispose,
    });
    document.addEventListener("playroom-popper", () => popperEvents++);
    const rebuildResolutionMap = installResolutionObserver(physics);
    installFrameObserver(engine, state, effects);
    setShadowTaskCasterMeshes(
        shadow,
        world.meshes.filter((mesh) => mesh.visible !== false)
    );
    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    await waitFrames(3);
    readyNativeSteps = native.worldSteps;
    readyGpuWriteCalls = gpuWrites.calls;
    readyGpuWriteBytes = gpuWrites.sourceBytes;
    readyDescriptorRebuilds = descriptorRebuilds;

    const output = document.getElementById("playroom-lifecycle-output");
    if (!output) {
        throw new Error("Missing lifecycle output.");
    }
    document.addEventListener("playroom-lifecycle-command", (event) => {
        const detail = (event as CustomEvent<{ id: string; action: "snapshot" | "wait" | "full"; frames?: number }>).detail;
        void (async () => {
            let result: object;
            if (detail.action === "wait") {
                await waitFrames(detail.frames ?? 1);
                result = report(state, effects, mode);
            } else if (detail.action === "full") {
                result = await runFullWorkload(state, effects, rebuildResolutionMap, removeEffects, mode);
            } else {
                result = report(state, effects, mode);
            }
            output.textContent = JSON.stringify(result);
            document.dispatchEvent(new CustomEvent("playroom-lifecycle-response", { detail: { id: detail.id, result } }));
        })().catch((error: unknown) => {
            document.dispatchEvent(
                new CustomEvent("playroom-lifecycle-response", {
                    detail: { id: detail.id, error: error instanceof Error ? error.message : String(error) },
                })
            );
        });
    });
    addEventListener("pagehide", () => disposePlayroomGame(state, effects), { once: true });
    canvas.dataset.ready = "true";
    canvas.dataset.mode = mode;
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas");
    if (canvas instanceof HTMLCanvasElement) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
