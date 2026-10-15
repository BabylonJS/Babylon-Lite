/**
 * Camera swap on the default (uncached) CSM path.
 *
 * Drives the REAL `renderCsmShadowMap`, the real cascade fit, real arc-rotate cameras and a real directional light;
 * only the GPU-facing render tasks and textures are stubbed. Each cascade re-render is counted through its task's
 * `execute`. The camera change key (`_cameraChangeKey`) sums counters that live on each camera, so two distinct cameras
 * can share it: a swap must still refit the cascades to the new camera.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => ({ executes: 0 }));

vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: () => ({
        record: () => {},
        execute: () => {
            counters.executes++;
            return 1;
        },
        dispose: () => {},
        _renderables: [],
        _pendingMeshes: [],
    }),
    addMeshToTask: () => {},
}));

const { ensureCsmShadowTaskState, renderCsmShadowMap } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks");
const { createArcRotateCamera } = await import("../../../packages/babylon-lite/src/camera/arc-rotate");
const { createDirectionalLight } = await import("../../../packages/babylon-lite/src/light/directional-light");
const { _cameraChangeKey } = await import("../../../packages/babylon-lite/src/camera/camera");

const WIDTH = 1920;
const HEIGHT = 1080;

function makeCamera(farPlane: number) {
    const camera = createArcRotateCamera(0, 0.95, 170, { x: 0, y: 3, z: 0 });
    camera.nearPlane = 0.5;
    camera.farPlane = farPlane;
    return camera;
}

function makeRig() {
    counters.executes = 0;
    const camera = makeCamera(900);
    const light = createDirectionalLight([-0.55, -1.0, -0.42], 2.2);
    const scene = { camera, surface: { scRT: { _width: WIDTH, _height: HEIGHT } }, _renderableVersion: 1 };
    const engine = { _device: { queue: { writeBuffer: () => {} } }, surfaces: [] };
    const cfg = {
        _numCascades: 3,
        _lambda: 0.7,
        _cascadeBlendPercentage: 0.1,
        _stabilizeCascades: true,
        _shadowMaxZ: 300,
        _bias: 0.0009,
        _worldSpaceBias: null,
        _darkness: 0.12,
        _frustumEdgeFalloff: 0,
        _mapSize: 1024,
        _forceRefreshEveryFrame: false,
    };
    const sg = { _light: light, _shadowUBO: {}, _version: 0, _depthTexture: { createView: () => ({}) }, _onReceiverData: undefined };
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const caster = { worldMatrix: identity, worldMatrixVersion: 1, thinInstances: null, boundMin: [-250, -5, -250], boundMax: [250, 40, 250], material: null };
    const state = ensureCsmShadowTaskState(engine as never, scene as never, sg as never, cfg as never, [caster] as never, null);
    const frame = (): void => {
        renderCsmShadowMap(engine as never, sg as never, state, cfg as never);
    };
    return { camera, scene, state, frame, executes: () => counters.executes };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("renderCsmShadowMap camera swap", () => {
    it("refits every cascade to the new camera even when both cameras share a change key and aspect", () => {
        const rig = makeRig();
        for (let f = 0; f < 10; f++) {
            rig.frame();
        }
        // A still scene renders the cascades once, then skips.
        expect(rig.executes()).toBe(3);
        // shadowMaxZ 300 caps the last split of the far-plane-900 camera.
        expect(rig.state._uboData[66]).toBeCloseTo(300, 3);
        const other = makeCamera(200);
        // Same transform version and projection revision: only the camera identity tells the two apart.
        expect(_cameraChangeKey(other)).toBe(_cameraChangeKey(rig.camera));
        rig.scene.camera = other;
        rig.frame();
        expect(rig.executes()).toBe(6);
        // shadowMaxZ 300 is beyond the new far plane, so the last split is that far plane.
        expect(rig.state._uboData[66]).toBeCloseTo(200, 3);
        for (let f = 0; f < 10; f++) {
            rig.frame();
        }
        expect(rig.executes()).toBe(6);
    });
});
