/**
 * Opt-in camera-coverage refit of the CSM static cache (`cascadeCoveragePadding`).
 *
 * Drives the REAL `renderCsmShadowMapCached`, the real cascade fit, a real arc-rotate camera and a real directional
 * light; only the GPU-facing render tasks and textures are stubbed. Each static cascade re-render is counted through
 * its task's `execute`, and after every frame the PUBLISHED receiver matrices are checked to cover the camera's current
 * slice. That check re-implements the cache's own coverage rule (slice corners inside the unit disc of shadow clip space
 * and inside the [0, 2R] light-depth range) from the receiver UBO and the shadow cameras: it is the same rule written a
 * second time, not an independent criterion, so it catches a broken or bypassed test but not a wrong rule.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as CsmShadowTaskHooks from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";

const counters = vi.hoisted(() => ({ executes: new Map<string, number>(), fits: 0 }));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: (config: { name: string }) => ({
        record: () => {},
        execute: () => {
            counters.executes.set(config.name, (counters.executes.get(config.name) ?? 0) + 1);
            return 1;
        },
        dispose: () => {},
        _renderables: [],
        _pendingMeshes: [],
        _opaqueBindings: [],
        _directBindings: [],
        _transparentBindings: [],
        _lastVersion: -1,
        _ob: [],
    }),
    _buildBindings: () => ({}),
    addMeshToTask: () => {},
    _enableTaskMeshPopulation: () => {},
    _resolvePendingMeshes: () => {},
}));
vi.mock("../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js", () => ({
    retireGpuResources: (_engine: unknown, dispose: () => void) => dispose(),
    runGpuResourceCallbacks: () => {},
}));
vi.mock("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks.js", async (importOriginal) => {
    const original = await importOriginal<typeof CsmShadowTaskHooks>();
    return {
        ...original,
        _computeCsmCascades: (...args: Parameters<typeof original._computeCsmCascades>) => {
            counters.fits++;
            return original._computeCsmCascades(...args);
        },
    };
});

const { ensureCsmShadowCacheState, renderCsmShadowMapCached } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-cache");
const { createArcRotateCamera } = await import("../../../packages/babylon-lite/src/camera/arc-rotate");
const { createDirectionalLight } = await import("../../../packages/babylon-lite/src/light/directional-light");
const { getViewProjectionMatrix, _cameraChangeKey } = await import("../../../packages/babylon-lite/src/camera/camera");
const { invertMat4ToRefOrIdentity } = await import("../../../packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity");

const FRAME_MS = 1000 / 60;
const WIDTH = 2752;
const HEIGHT = 1152;

interface RigOptions {
    padding: number;
    /** CottageCore: 100 ms wall-time floor. */
    refitMaxIntervalMs?: number;
    /** CottageCore: 1 cascade per frame for drift-only refits. */
    staticCascadesPerFrame?: number;
    /** Sun rotation per frame (rad); CottageCore's day runs about 1.45e-4 rad/frame at 1x. 0 = paused sun. */
    sunRadPerFrame?: number;
    mapSize?: number;
}

/** CottageCore's High preset on the glade (glade-config.ts `lighting.shadow`, glade.json `camera`). */
function makeRig(options: RigOptions) {
    counters.executes.clear();
    counters.fits = 0;
    let nowMs = 0;
    let receiverCalls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const camera = createArcRotateCamera(0, 0.95, 170, { x: 0, y: 3, z: 0 });
    camera.nearPlane = 0.5;
    camera.farPlane = 900;
    const light = createDirectionalLight([-0.55, -1.0, -0.42], 2.2);
    const scene = { camera, surface: { scRT: { _width: WIDTH, _height: HEIGHT } }, _renderableVersion: 1 };
    const fakeTexture = { createView: () => ({}), destroy: () => {} };
    const engine = {
        _device: { createTexture: () => fakeTexture, queue: { writeBuffer: () => {} } },
        _currentEncoder: { copyTextureToTexture: () => {} },
        surfaces: [],
    };
    const mapSize = options.mapSize ?? 2048;
    const cfg = {
        _numCascades: 3,
        _lambda: 0.7,
        _cascadeBlendPercentage: 0.1,
        _stabilizeCascades: true,
        _shadowMaxZ: 300,
        _bias: 0.0009,
        _worldSpaceBias: 0.035,
        _darkness: 0.12,
        _frustumEdgeFalloff: 0,
        _mapSize: mapSize,
        _forceRefreshEveryFrame: false,
    };
    const sg = {
        _light: light,
        _shadowUBO: {},
        _version: 0,
        _depthTexture: fakeTexture,
        // One `onCsmReceiverUpdate` subscriber, counting the frames it is invoked on.
        _onReceiverData: [() => receiverCalls++],
        _csmCache: {
            _refitAngle: 0.0015,
            _refitMaxIntervalMs: options.refitMaxIntervalMs ?? 100,
            _staticCascadesPerFrame: options.staticCascadesPerFrame ?? 1,
            _cascadeCoveragePadding: options.padding,
        },
    };
    // One static caster spanning a big glade, so the caster-bound Z tightening is exercised as in the game.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const caster = { worldMatrix: identity, worldMatrixVersion: 1, thinInstances: null, boundMin: [-250, -5, -250], boundMax: [250, 40, 250], material: null };
    const state = ensureCsmShadowCacheState(engine as never, scene as never, sg as never, cfg as never, [caster] as never, null);
    const sunStep = options.sunRadPerFrame ?? 0;

    const staticCount = (): number => {
        let total = 0;
        for (let cascade = 0; cascade < 3; cascade++) {
            total += counters.executes.get(`csm${cascade}-static`) ?? 0;
        }
        return total;
    };
    const perCascade = (): number[] => [0, 1, 2].map((cascade) => counters.executes.get(`csm${cascade}-static`) ?? 0);

    /** Worst corner reach of the current slice in each cascade's PUBLISHED map (1 = edge of the coverage rule). */
    const corners = Array.from({ length: 8 }, () => [0, 0, 0]);
    const inv = new Float32Array(16);
    const ndc = [
        [-1, 1, 1],
        [1, 1, 1],
        [1, -1, 1],
        [-1, -1, 1],
        [-1, 1, 0],
        [1, 1, 0],
        [1, -1, 0],
        [-1, -1, 0],
    ];
    const publishedReach = (): number[] => {
        const ubo = state._uboData;
        invertMat4ToRefOrIdentity(getViewProjectionMatrix(camera, WIDTH / HEIGHT) as never, inv as never);
        const reach: number[] = [];
        let prev = 0;
        for (let cascade = 0; cascade < 3; cascade++) {
            const split = (ubo[64 + cascade]! - camera.nearPlane) / (camera.farPlane - camera.nearPlane);
            for (let k = 0; k < 8; k++) {
                const [x, y, z] = ndc[k]!;
                const X = inv[0]! * x! + inv[4]! * y! + inv[8]! * z! + inv[12]!;
                const Y = inv[1]! * x! + inv[5]! * y! + inv[9]! * z! + inv[13]!;
                const Z = inv[2]! * x! + inv[6]! * y! + inv[10]! * z! + inv[14]!;
                const W = inv[3]! * x! + inv[7]! * y! + inv[11]! * z! + inv[15]!;
                corners[k] = [X / W, Y / W, Z / W];
            }
            let worst = 0;
            for (let k = 0; k < 4; k++) {
                const n = corners[k]!;
                const f = corners[k + 4]!;
                for (const t of [prev, split]) {
                    const p = [n[0]! + (f[0]! - n[0]!) * t, n[1]! + (f[1]! - n[1]!) * t, n[2]! + (f[2]! - n[2]!) * t];
                    const o = cascade * 16;
                    const cx = ubo[o]! * p[0]! + ubo[o + 4]! * p[1]! + ubo[o + 8]! * p[2]! + ubo[o + 12]!;
                    const cy = ubo[o + 1]! * p[0]! + ubo[o + 5]! * p[1]! + ubo[o + 9]! * p[2]! + ubo[o + 13]!;
                    // Light depth from the published light view, normalised so the fit's [0, 2R] range maps to [-1, 1].
                    const v = (state._cameras[cascade] as unknown as { _viewCache: Float32Array })._viewCache;
                    const z = v[2]! * p[0]! + v[6]! * p[1]! + v[10]! * p[2]! + v[14]!;
                    const depth = 2 / Math.hypot(ubo[o]!, ubo[o + 4]!, ubo[o + 8]!);
                    worst = Math.max(worst, Math.hypot(cx, cy), Math.abs((2 * z) / depth - 1));
                }
            }
            prev = split;
            reach.push(worst);
        }
        return reach;
    };
    /** World size of one shadow texel per cascade, from the published receiver matrix (X row length = 1/R). */
    const texelWorld = (): number[] => [0, 1, 2].map((c) => 2 / Math.hypot(state._uboData[c * 16]!, state._uboData[c * 16 + 4]!, state._uboData[c * 16 + 8]!) / mapSize);

    const frame = (): void => {
        if (sunStep) {
            // Rotate the sun about the vertical axis: what the day/night director does, at its measured rate.
            const { x, z } = light.direction;
            const c = Math.cos(sunStep);
            const s = Math.sin(sunStep);
            light.direction.x = x * c - z * s;
            light.direction.z = x * s + z * c;
        }
        renderCsmShadowMapCached(engine as never, sg as never, state, cfg as never);
        nowMs += FRAME_MS;
    };
    return { camera, light, scene, state, frame, staticCount, perCascade, publishedReach, texelWorld, fits: () => counters.fits, receiverCalls: () => receiverCalls };
}

type Rig = ReturnType<typeof makeRig>;
type Path = (rig: Rig, frame: number) => void;

const orbit =
    (lapSeconds: number, radius = 170, beta = 0.95): Path =>
    (rig, f) => {
        rig.camera.radius = radius;
        rig.camera.beta = beta;
        rig.camera.alpha = (f / (lapSeconds * 60)) * Math.PI * 2;
    };
const pan =
    (metresPerSecond: number, radius = 60): Path =>
    (rig, f) => {
        rig.camera.radius = radius;
        rig.camera.beta = 0.95;
        rig.camera.target.x = (f / 60) * metresPerSecond;
    };
/** The camera target slides along the light direction: the move the clip-space disc cannot see. */
const alongLight =
    (metresPerSecond: number): Path =>
    (rig, f) => {
        const d = Math.hypot(0.55, 1, 0.42);
        const t = ((f - 200) / 60) * metresPerSecond;
        rig.camera.radius = 60;
        rig.camera.beta = 0.95;
        rig.camera.target.x = (-0.55 / d) * t;
        rig.camera.target.y = 3 + (-1 / d) * t;
        rig.camera.target.z = (-0.42 / d) * t;
    };
/** Warm up (first refit + the one demotion-overdue refit of the quiet caster), then measure `frames` frames. */
function run(options: RigOptions, path: Path, frames = 1440) {
    const rig = makeRig(options);
    const warm = 200;
    for (let f = 0; f < warm; f++) {
        path(rig, f);
        rig.frame();
    }
    const startStatic = rig.staticCount();
    const startPer = rig.perCascade();
    const startFits = rig.fits();
    let worstReach = 0;
    for (let f = warm; f < warm + frames; f++) {
        path(rig, f);
        rig.frame();
        worstReach = Math.max(worstReach, ...rig.publishedReach());
    }
    const per = rig.perCascade().map((v, i) => v - startPer[i]!);
    return {
        staticPer100: ((rig.staticCount() - startStatic) * 100) / frames,
        perCascadePer100: per.map((v) => +((v * 100) / frames).toFixed(1)),
        fitsPer100: ((rig.fits() - startFits) * 100) / frames,
        worstReach,
        texelWorld: rig.texelWorld(),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("CSM static cache camera-coverage refit (cascadeCoveragePadding)", () => {
    it("default (padding 0): an orbit re-renders all three static cascades every frame, as before", () => {
        const result = run({ padding: 0 }, orbit(24), 300);
        expect(result.staticPer100).toBe(300);
        expect(result.fitsPer100).toBe(100);
    });

    it("padding 0.2: the same orbit re-renders far fewer static cascades and never shows an uncovered slice", () => {
        const result = run({ padding: 0.2 }, orbit(24));
        expect(result.staticPer100).toBeLessThan(100);
        // The published maps always cover the camera's current slice (unit disc of shadow clip space).
        expect(result.worstReach).toBeLessThanOrEqual(1);
    });

    it("without the wall-time floor, coverage misses alone keep every published map covering its slice", () => {
        // The 100 ms floor re-centres every cascade every 6 frames, so above it rarely gets to miss; here only the
        // coverage test refits, and the re-implemented reach check must still never leave the unit disc.
        const result = run({ padding: 0.1, refitMaxIntervalMs: 0 }, orbit(8));
        expect(result.staticPer100).toBeGreaterThan(0);
        expect(result.staticPer100).toBeLessThan(50);
        expect(result.worstReach).toBeLessThanOrEqual(1);
    });

    it("a camera sliding along the light direction is caught by the light-depth check", () => {
        const result = run({ padding: 0.1, refitMaxIntervalMs: 0 }, alongLight(20), 600);
        expect(result.staticPer100).toBeGreaterThan(0);
        expect(result.worstReach).toBeLessThanOrEqual(1);
    });

    it("padding widens each cascade's texel by the padding factor", () => {
        const base = run({ padding: 0 }, orbit(24), 10).texelWorld;
        const padded = run({ padding: 0.2 }, orbit(24), 10).texelWorld;
        for (let cascade = 0; cascade < 3; cascade++) {
            expect(padded[cascade]! / base[cascade]!).toBeGreaterThan(1.18);
            expect(padded[cascade]! / base[cascade]!).toBeLessThan(1.22);
        }
    });

    it("a still camera costs nothing beyond the wall-time floor", () => {
        const still = run({ padding: 0.2 }, () => {}, 600);
        const stillDefault = run({ padding: 0 }, () => {}, 600);
        expect(still.staticPer100).toBe(stillDefault.staticPer100);
    });

    it("a coverage miss re-renders only the cascades that left, and the others keep their camera matrices", () => {
        const rig = makeRig({ padding: 0.05, refitMaxIntervalMs: 0 });
        const path = orbit(24);
        for (let f = 0; f < 200; f++) {
            path(rig, f);
            rig.frame();
        }
        const cameras = rig.state._cameras as unknown as { _vpCache: Float32Array; worldMatrixVersion: number }[];
        let partialFrames = 0;
        for (let f = 200; f < 800; f++) {
            const before = rig.perCascade();
            const snapshots = cameras.map((camera) => ({ vp: Float32Array.from(camera._vpCache), version: camera.worldMatrixVersion }));
            path(rig, f);
            rig.frame();
            const rendered = rig.perCascade().map((count, cascade) => count - before[cascade]!);
            if (rendered.some((count) => count === 0) && rendered.some((count) => count > 0)) {
                partialFrames++;
                for (let cascade = 0; cascade < 3; cascade++) {
                    if (rendered[cascade] === 0) {
                        // Not re-rendered: same camera version and the same matrix VALUES, although the shared fit scratch
                        // was recomputed this frame for the cascade that missed.
                        expect(cameras[cascade]!.worldMatrixVersion).toBe(snapshots[cascade]!.version);
                        expect(Array.from(cameras[cascade]!._vpCache)).toEqual(Array.from(snapshots[cascade]!.vp));
                    }
                }
            }
            expect(rendered.every((count) => count <= 1)).toBe(true);
        }
        expect(partialFrames).toBeGreaterThan(0);
    });

    it("a field-of-view change refits every cascade in that frame", () => {
        const rig = makeRig({ padding: 0.2, refitMaxIntervalMs: 0 });
        for (let f = 0; f < 200; f++) {
            rig.frame();
        }
        const before = rig.staticCount();
        rig.camera.fov = 0.7;
        rig.frame();
        expect(rig.staticCount() - before).toBe(3);
    });
    it("a camera swap refits every cascade with the new camera's splits, even when both share a projection revision", () => {
        const rig = makeRig({ padding: 0.1, refitMaxIntervalMs: 0 });
        for (let f = 0; f < 200; f++) {
            rig.frame();
        }
        // A fresh camera reaches projection revision 1 on first use, like the rig camera: only its identity differs.
        const other = createArcRotateCamera(0, 0.95, 170, { x: 0, y: 3, z: 0 });
        other.nearPlane = 0.5;
        other.farPlane = 200;
        rig.scene.camera = other;
        const before = rig.staticCount();
        rig.frame();
        expect(rig.staticCount() - before).toBe(3);
        // shadowMaxZ 300 is beyond the new far plane, so the last split is that far plane.
        expect(rig.state._uboData[66]).toBeCloseTo(200, 3);
        const settled = rig.staticCount();
        for (let f = 0; f < 10; f++) {
            rig.frame();
        }
        expect(rig.staticCount()).toBe(settled);
    });

    it("default (padding 0): a camera swap refits every cascade even when both cameras share a change key", () => {
        const rig = makeRig({ padding: 0, refitMaxIntervalMs: 0 });
        for (let f = 0; f < 200; f++) {
            rig.frame();
        }
        const other = createArcRotateCamera(0, 0.95, 170, { x: 0, y: 3, z: 0 });
        other.nearPlane = 0.5;
        other.farPlane = 200;
        // Same transform version and projection revision: only the camera identity tells the two apart.
        expect(_cameraChangeKey(other)).toBe(_cameraChangeKey(rig.camera));
        rig.scene.camera = other;
        const before = rig.staticCount();
        rig.frame();
        expect(rig.staticCount() - before).toBe(3);
        expect(rig.state._uboData[66]).toBeCloseTo(200, 3);
        const settled = rig.staticCount();
        for (let f = 0; f < 10; f++) {
            rig.frame();
        }
        expect(rig.staticCount()).toBe(settled);
    });

    it("cascades a spread refit publishes late are refit to the pose they are shown with (seeded back-and-forth yaw jumps)", () => {
        // Small padding and the 100 ms spread floor; the camera yaws back and forth in random jumps and stops. Before the
        // fix, a cascade published one or two frames after its fit could miss the slice and never be tested again.
        let worst = 0;
        for (let seed = 1; seed <= 30; seed++) {
            let lcg = seed * 7919;
            const random = (): number => (lcg = (lcg * 1103515245 + 12345) % 2147483648) / 2147483648;
            const rig = makeRig({ padding: 0.05 });
            rig.camera.radius = 60;
            for (let f = 0; f < 200; f++) {
                rig.frame();
            }
            for (let f = 0; f < 600; f++) {
                if (random() < 0.3) {
                    rig.camera.alpha += (random() * 2 - 1) * 0.12;
                }
                rig.frame();
                worst = Math.max(worst, ...rig.publishedReach());
            }
        }
        expect(worst).toBeLessThanOrEqual(1);
    });

    it("a coverage miss during a spread re-renders the missed cascades once, not again when the spread reaches them", () => {
        const rig = makeRig({ padding: 0.1 });
        for (let f = 0; f < 200; f++) {
            rig.frame();
        }
        // Find the first frame of a spread floor refit (one cascade after a quiet frame) with a still camera.
        let previous = -1;
        for (let f = 0; f < 60; f++) {
            const before = rig.staticCount();
            rig.frame();
            const delta = rig.staticCount() - before;
            if (delta === 1 && previous === 0) {
                break;
            }
            previous = delta;
        }
        // Next frame the camera jumps far: every cascade misses, the two still pending included.
        rig.camera.target.x += 1000;
        const atJump = rig.staticCount();
        rig.frame();
        expect(rig.staticCount() - atJump).toBe(3);
        // The camera is still again; the spread has nothing left to render (the floor is 100 ms, 6 frames, away).
        const afterJump = rig.staticCount();
        rig.frame();
        rig.frame();
        rig.frame();
        expect(rig.staticCount()).toBe(afterJump);
    });

    it("under a floating origin every camera move refits, as without the option", () => {
        // The camera view-projection is eye-relative there, so a translation moves no slice corner.
        const rig = makeRig({ padding: 0.1 });
        (rig.camera as unknown as { _useFloatingOrigin: boolean })._useFloatingOrigin = true;
        const path = pan(2);
        for (let f = 0; f < 200; f++) {
            path(rig, f);
            rig.frame();
        }
        const before = rig.staticCount();
        for (let f = 200; f < 300; f++) {
            path(rig, f);
            rig.frame();
        }
        expect(rig.staticCount() - before).toBe(300);
    });

    it("keeps the receiver callbacks per-frame while the camera key changes, and adds none for a still camera", () => {
        // `onCsmReceiverUpdate` is documented as per-frame: without the option every camera change refits and invokes
        // it, and consumers re-upload camera-dependent terms from it. The coverage refit must keep that cadence even on
        // frames that redraw no cascade, and must not add callbacks the default path would not make.
        const callbacks = (padding: number, path: Path): number => {
            const rig = makeRig({ padding });
            for (let f = 0; f < 200; f++) {
                path(rig, f);
                rig.frame();
            }
            const before = rig.receiverCalls();
            for (let f = 200; f < 320; f++) {
                path(rig, f);
                rig.frame();
            }
            return rig.receiverCalls() - before;
        };
        // The pose is essentially still but the camera key changes every frame.
        const keyEveryFrame: Path = (rig, f) => {
            rig.camera.alpha += f % 2 ? 1e-9 : -1e-9;
        };
        const still: Path = () => {};
        expect(callbacks(0, keyEveryFrame)).toBe(120);
        expect(callbacks(0.1, keyEveryFrame)).toBe(120);
        expect(callbacks(0.1, orbit(60))).toBe(callbacks(0, orbit(60)));
        // A still camera: only the refits (the 100 ms floor, spread one cascade per frame) invoke them, as by default.
        expect(callbacks(0.1, still)).toBe(callbacks(0, still));
        expect(callbacks(0.1, still)).toBeLessThan(120);
    });
});
