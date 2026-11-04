/**
 * CSM static cache, spread refit (`staticCascadesPerFrame`) without the camera-coverage refit.
 *
 * A spread refit fits every cascade at once into the shared cascade scratch but re-renders and publishes only the
 * budgeted cascades per frame; the others keep showing their previous static depth. A shadow camera keeps references
 * to the matrices it is given (`updateShadowCameraBase`), so a published cascade must not alias that scratch: the next
 * fit would otherwise rewrite the matrix of a cascade that has not been re-rendered yet, and every consumer of its
 * camera (the dynamic overlay draw, its GPU frustum culling) would use a fit its static layer was never rendered with.
 *
 * Drives the REAL `renderCsmShadowMapCached`, the real cascade fit and scratch, the real shadow camera facade, a real
 * arc-rotate camera and a real directional light; only the GPU-facing render tasks and textures are stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";

const tasks = vi.hoisted(() => ({
    onExecute: null as ((name: string, camera: unknown) => void) | null,
}));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: (config: { name: string; cam: unknown }) => ({
        record: () => {},
        execute: () => {
            tasks.onExecute?.(config.name, config.cam);
            return 1;
        },
        dispose: () => {},
        // The dynamic overlay holds a caster, so its pass is not skipped as empty.
        _renderables: config.name.endsWith("-static") ? [] : [{}],
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

const { ensureCsmShadowCacheState, renderCsmShadowMapCached } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-cache");
const { createArcRotateCamera } = await import("../../../packages/babylon-lite/src/camera/arc-rotate");
const { createDirectionalLight } = await import("../../../packages/babylon-lite/src/light/directional-light");
const { getViewProjectionMatrix } = await import("../../../packages/babylon-lite/src/camera/camera");

const CASCADES = 3;

function makeRig() {
    const camera = createArcRotateCamera(0, 0.95, 170, { x: 0, y: 3, z: 0 });
    camera.nearPlane = 0.5;
    camera.farPlane = 900;
    const light = createDirectionalLight([-0.55, -1.0, -0.42], 2.2);
    const scene = { camera, surface: { scRT: { _width: 1600, _height: 900 } }, _renderableVersion: 1 };
    const fakeTexture = { createView: () => ({}), destroy: () => {} };
    const engine = {
        _device: { createTexture: () => fakeTexture, queue: { writeBuffer: () => {} } },
        _currentEncoder: { copyTextureToTexture: () => {} },
        surfaces: [],
    };
    const cfg = {
        _numCascades: CASCADES,
        _lambda: 0.7,
        _cascadeBlendPercentage: 0.1,
        _stabilizeCascades: true,
        _shadowMaxZ: 300,
        _bias: 0.0009,
        _worldSpaceBias: 0.035,
        _darkness: 0.12,
        _frustumEdgeFalloff: 0,
        _mapSize: 2048,
        _forceRefreshEveryFrame: false,
    };
    const sg = {
        _light: light,
        _shadowUBO: {},
        _version: 0,
        _depthTexture: fakeTexture,
        _onReceiverData: null,
        _csmCache: {
            _refitAngle: 0.0015,
            // No wall-time floor: only the sun drift below refits, so the spread is deterministic.
            _refitMaxIntervalMs: 0,
            _staticCascadesPerFrame: 1,
            _cascadeCoveragePadding: 0,
        },
    };
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // A quiet caster that settles into the static layer, and one that moves every frame and so stays in the overlay.
    const ground = { worldMatrix: identity, worldMatrixVersion: 1, thinInstances: null, boundMin: [-250, -5, -250], boundMax: [250, 40, 250], material: null };
    const mover = { worldMatrix: identity, worldMatrixVersion: 1, thinInstances: null, boundMin: [-1, 0, -1], boundMax: [1, 2, 1], material: null };
    const state = ensureCsmShadowCacheState(engine as never, scene as never, sg as never, cfg as never, [ground, mover] as never, null);

    // Per cascade: the view-projection its static depth layer was last rendered with, and every overlay draw that read
    // a different one from the same shadow camera.
    const staticViewProj: (Float32Array | null)[] = new Array<Float32Array | null>(CASCADES).fill(null);
    const staticRenders = new Array<number>(CASCADES).fill(0);
    const mismatchedOverlayDraws: number[] = [];
    tasks.onExecute = (name, shadowCamera) => {
        const cascade = Number(name.slice(3, 4));
        const viewProj = Float32Array.from(getViewProjectionMatrix(shadowCamera as Camera, 1) as ArrayLike<number>);
        if (name.endsWith("-static")) {
            staticViewProj[cascade] = viewProj;
            staticRenders[cascade]!++;
        } else if (staticViewProj[cascade] && viewProj.some((value, i) => value !== staticViewProj[cascade]![i])) {
            mismatchedOverlayDraws.push(cascade);
        }
    };

    const frame = (): void => {
        mover.worldMatrixVersion++;
        renderCsmShadowMapCached(engine as never, sg as never, state, cfg as never);
    };
    const rotateSun = (radians: number): void => {
        const { x, z } = light.direction;
        light.direction.x = x * Math.cos(radians) - z * Math.sin(radians);
        light.direction.z = x * Math.sin(radians) + z * Math.cos(radians);
    };
    const cameraViewProj = (cascade: number): Float32Array => Float32Array.from(getViewProjectionMatrix(state._cameras[cascade]!, 1) as ArrayLike<number>);
    const gate = (state as unknown as { _gate: { isDynamic(mesh: unknown): boolean } })._gate;
    return { state, frame, rotateSun, cameraViewProj, staticRenders, mismatchedOverlayDraws, isStatic: () => !gate.isDynamic(ground) && gate.isDynamic(mover) };
}

describe("CSM static cache spread refit: shadow cameras own their published matrices", () => {
    afterEach(() => {
        tasks.onExecute = null;
    });

    /** Settle until the quiet caster is demoted into the static layer (default 120 quiet frames) and nothing pends. */
    function settledRig() {
        const rig = makeRig();
        for (let i = 0; i < 130; i++) {
            rig.frame();
        }
        expect(rig.isStatic()).toBe(true);
        return rig;
    }

    it("keeps a not-yet-re-rendered cascade's camera on the matrix its static layer was rendered with", () => {
        const rig = settledRig();
        const before = [0, 1, 2].map(rig.cameraViewProj);
        const renders = rig.staticRenders.slice();

        rig.rotateSun(0.01); // past the refit angle: a drift-only refit, spread one cascade per frame
        rig.frame();

        const rendered = rig.staticRenders.map((count, cascade) => count - renders[cascade]!);
        expect(rendered.reduce((sum, n) => sum + n, 0)).toBe(1); // the spread really published a single cascade
        for (let cascade = 0; cascade < CASCADES; cascade++) {
            if (rendered[cascade]) {
                expect(rig.cameraViewProj(cascade)).not.toEqual(before[cascade]); // the refreshed cascade moved on
            } else {
                expect(rig.cameraViewProj(cascade)).toEqual(before[cascade]); // the pending ones did not
            }
        }
    });

    it("draws every dynamic overlay with the same matrix as its static depth layer while the spread drains", () => {
        const rig = settledRig();
        const renders = rig.staticRenders.slice();

        rig.rotateSun(0.01);
        rig.frame();
        rig.frame();
        rig.frame();

        expect(rig.staticRenders).toEqual(renders.map((count) => count + 1)); // drained, one cascade per frame
        expect(rig.mismatchedOverlayDraws).toEqual([]);
    });
});
