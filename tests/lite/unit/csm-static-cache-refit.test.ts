import { beforeEach, describe, expect, it, vi } from "vitest";

const taskMocks = vi.hoisted(() => ({
    record: vi.fn(),
    dispose: vi.fn(),
}));

// The static layer is a cached draw recording that lives in a TEXTURE: it is only redrawn on a refit.
// `_renderableVersion` is the engine's "every cached draw recording is now invalid" signal (bumped by
// `resizeMeshGeometry` / `invalidateRenderBundles` when a procedural caster re-uploads its geometry),
// and the refit gate cannot see it — a caster's transform and thin-instance versions are unchanged by
// a geometry rebuild. Without this trigger the layer keeps showing the previous geometry until some
// unrelated refit (a camera move, the sun drifting past the epsilon) happens to redraw it.

vi.mock("../../../packages/babylon-lite/src/camera/camera.js", () => ({
    _cameraChangeKey: (camera: { key: number }) => camera.key,
}));
vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", () => ({
    createShadowCamera: () => ({}),
    updateShadowCameraBase: () => {},
}));
vi.mock("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks.js", () => ({
    csmCameraAspect: () => 1,
    csmWorldBiasClipOffset: () => 0,
    _biasViewProjection: () => {},
    _writeCsmUbo: () => {},
    _computeCsmCascades: () => ({ _transforms: [new Float32Array(16)], _views: [new Float32Array(16)], _near: [0], _far: [1] }),
    _createCascadeScratch: () => ({}),
}));
vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", () => ({
    createRenderTask: () => ({
        addMesh: vi.fn(),
        removeMesh: vi.fn(),
        record: taskMocks.record,
        execute: vi.fn(() => 0),
        dispose: taskMocks.dispose,
        _lastVersion: -1,
    }),
    _buildBindings: vi.fn(),
    _resolvePendingMeshes: vi.fn(),
    removeMeshFromTask: vi.fn(),
}));
vi.mock("../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js", () => ({
    retireGpuResources: (_engine: unknown, dispose: () => void) => dispose(),
}));

const { ensureCsmShadowCacheState, renderCsmShadowMapCached } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-cache");
const { createCsmRefitGate, createCsmStaticRefitScheduler } = await import("../../../packages/babylon-lite/src/shadow/csm-refit-gate");

function makeHarness() {
    const staticExecute = vi.fn(() => 1);
    const dynamicExecute = vi.fn(() => 1);
    const scene = { camera: { key: 1 }, _renderableVersion: 7 };
    const caster = { worldMatrixVersion: 1, thinInstances: null };
    const gate = createCsmRefitGate<typeof caster>({ refitAngle: 1, refitMaxIntervalMs: 0, demoteQuietFrames: 2 });
    const state = {
        _scene: scene,
        _cameras: [{}],
        _uboData: new Float32Array(80),
        _casterMeshes: [caster],
        _staticTasks: [{ execute: staticExecute }],
        _tasks: [{ execute: dynamicExecute }],
        _gate: gate,
        _staticScheduler: createCsmStaticRefitScheduler(1, 0),
        _onPromote: () => {},
        _onDemote: () => {},
        _pendingTransfers: new Set(),
        _cachedContentVersion: -1,
        _lastCamVersion: -1,
        _lastCamAspect: -1,
    };
    const engine = {
        _device: { queue: { writeBuffer: vi.fn() } },
        _currentEncoder: { copyTextureToTexture: vi.fn() },
    };
    const sg = { _light: { direction: { x: 0, y: -1, z: 0 } }, _shadowUBO: {}, _version: 0, _depthTexture: {} };
    const cfg = { _numCascades: 1, _mapSize: 4, _bias: 0, _worldSpaceBias: null, _forceRefreshEveryFrame: false };

    const render = () => renderCsmShadowMapCached(engine as any, sg as any, state as any, cfg as any);
    return { render, scene, caster, staticExecute, dynamicExecute };
}

describe("renderCsmShadowMapCached static-layer invalidation", () => {
    let h: ReturnType<typeof makeHarness>;

    /** Drive the harness to the settled state the bug lives in: the caster is quiet, has been demoted
     *  into the static layer, and no further frame redraws that layer on its own. */
    function settleIntoStaticLayer(): void {
        for (let i = 0; i < 6; i++) {
            h.render();
        }
        const settled = h.staticExecute.mock.calls.length;
        h.render();
        expect(h.staticExecute).toHaveBeenCalledTimes(settled); // proves the layer really is parked
    }

    beforeEach(() => {
        h = makeHarness();
        settleIntoStaticLayer();
    });

    describe("ensureCsmShadowCacheState hook transition", () => {
        it("records replacement cache tasks when a default state appeared during the async enable window", () => {
            taskMocks.record.mockClear();
            const foreignDispose = vi.fn();
            const engine = {
                _device: {
                    createTexture: vi.fn(() => ({ createView: vi.fn(), destroy: vi.fn() })),
                },
            };
            const scene = { _renderableVersion: 1, _materialEpoch: 1 };
            const sg = {
                _depthTexture: { createView: vi.fn() },
                _csmCache: { a: 0.1, i: 0 },
            };
            const config = { _numCascades: 1, _mapSize: 4 };
            const foreign = {
                _task: { record: vi.fn(), dispose: foreignDispose },
                _casterMeshes: [],
            };

            ensureCsmShadowCacheState(engine as any, scene as any, sg as any, config as any, [], foreign as any);

            expect(foreignDispose).toHaveBeenCalledOnce();
            expect(taskMocks.record).toHaveBeenCalledTimes(2);
        });
    });

    it("redraws the static layer when a caster's GEOMETRY is rebuilt, not only when it moves", () => {
        const before = h.staticExecute.mock.calls.length;
        // A procedural caster re-uploaded its geometry. Its transform and thin-instance versions are
        // untouched, so this bump is the ONLY evidence the gate can be given.
        h.scene._renderableVersion++;
        h.render();
        expect(h.staticExecute).toHaveBeenCalledTimes(before + 1);

        h.render(); // and it parks again immediately afterwards
        expect(h.staticExecute).toHaveBeenCalledTimes(before + 1);
    });

    it("still redraws the static layer when a demoted caster MOVES", () => {
        const before = h.staticExecute.mock.calls.length;
        h.caster.worldMatrixVersion++;
        h.render();
        expect(h.staticExecute).toHaveBeenCalledTimes(before + 1);
    });
});

describe("renderCsmShadowMapCached spread static refit (staticCascadesPerFrame)", () => {
    function makeSpreadHarness(cascadesPerFrame: number) {
        const staticExecutes = [vi.fn(() => 1), vi.fn(() => 1), vi.fn(() => 1)];
        const dynamicExecute = vi.fn(() => 1);
        const scene = { camera: { key: 1 }, _renderableVersion: 7 };
        const caster = { worldMatrixVersion: 1, thinInstances: null };
        const gate = createCsmRefitGate<typeof caster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 2 });
        const state = {
            _scene: scene,
            _cameras: [{}, {}, {}],
            _uboData: new Float32Array(80),
            _casterMeshes: [caster],
            _staticTasks: staticExecutes.map((execute) => ({ execute })),
            _tasks: [{ execute: dynamicExecute }, { execute: dynamicExecute }, { execute: dynamicExecute }],
            _gate: gate,
            _staticScheduler: createCsmStaticRefitScheduler(3, cascadesPerFrame),
            _onPromote: () => {},
            _onDemote: () => {},
            _pendingTransfers: new Set(),
            _cachedContentVersion: -1,
            _lastCamVersion: -1,
            _lastCamAspect: -1,
        };
        const copy = vi.fn();
        const engine = {
            _device: { queue: { writeBuffer: vi.fn() } },
            _currentEncoder: { copyTextureToTexture: copy },
        };
        const sg = { _light: { direction: { x: 0, y: -1, z: 0 } }, _shadowUBO: {}, _version: 0, _depthTexture: {} };
        const cfg = { _numCascades: 3, _mapSize: 4, _bias: 0, _worldSpaceBias: null, _forceRefreshEveryFrame: false };
        const render = () => renderCsmShadowMapCached(engine as any, sg as any, state as any, cfg as any);
        const staticCalls = () => staticExecutes.map((fn) => fn.mock.calls.length);
        // Settle: first (full) refit, quiet frames, then a camera refit applies the demotion so the caster
        // sits in the static layer and drift alone drives the next refits.
        render();
        render();
        render();
        scene.camera.key++;
        render();
        expect(gate.isDynamic(caster)).toBe(false);
        return { render, scene, sg, copy, staticCalls, dynamicExecute };
    }

    it("re-renders one static cascade per frame after a drift refit, none of them later than maxLagFrames", () => {
        const h = makeSpreadHarness(1);
        const base = h.staticCalls();
        const copies = h.copy.mock.calls.length;
        h.sg._light.direction.x = 0.2; // angle epsilon crossed: a drift-only refit
        expect(h.render()).toBeGreaterThan(0);
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]!, base[2]!]); // refit frame: cascade 0 only
        expect(h.render()).toBeGreaterThan(0); // nothing dynamic changed, yet the pending cascade keeps the frame alive
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]!]);
        h.render();
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]); // lag 2 = maxLagFrames(3, 1)
        expect(h.copy.mock.calls.length).toBe(copies + 3); // the cache is copied to the sampled map on each of the three frames
        expect(h.render()).toBe(0); // drained and quiet: the frame does nothing again
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]);
    });

    it("re-renders every cascade in the refit frame when the camera moved, even with drift", () => {
        const h = makeSpreadHarness(1);
        const base = h.staticCalls();
        h.sg._light.direction.x = 0.2;
        h.scene.camera.key++;
        h.render();
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]);
        expect(h.render()).toBe(0);
    });

    it("keeps the single-frame re-render when the budget is 0 (historical behaviour)", () => {
        const h = makeSpreadHarness(0);
        const base = h.staticCalls();
        h.sg._light.direction.x = 0.2;
        h.render();
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]);
        expect(h.render()).toBe(0);
    });
});
