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
    updateShadowCameraBase: (camera: { viewProjection?: Float32Array }, _version: number, _near: number, _far: number, _view: Float32Array, viewProjection: Float32Array) => {
        camera.viewProjection = viewProjection;
    },
}));
vi.mock("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks.js", () => ({
    csmCameraAspect: () => 1,
    csmWorldBiasClipOffset: () => 0,
    _biasViewProjection: () => {},
    _writeCsmUbo: (out: Float32Array, cascades: { _transforms: Float32Array[] }) => {
        out.fill(0);
        for (let cascade = 0; cascade < cascades._transforms.length; cascade++) {
            out.set(cascades._transforms[cascade]!, cascade * 16);
        }
    },
    _computeCsmCascades: (_scene: unknown, _camera: unknown, light: { direction: { x: number } }, cfg: { _numCascades: number }) => {
        const transforms = Array.from({ length: cfg._numCascades }, (_, cascade) => {
            const transform = new Float32Array(16);
            transform[0] = cascade + 1 + light.direction.x;
            return transform;
        });
        return {
            _transforms: transforms,
            _views: Array.from({ length: cfg._numCascades }, () => new Float32Array(16)),
            _near: new Array<number>(cfg._numCascades).fill(0),
            _far: new Array<number>(cfg._numCascades).fill(1),
            _viewFrustumZ: new Array<number>(cfg._numCascades).fill(1),
            _frustumLengths: new Array<number>(cfg._numCascades).fill(1),
        };
    },
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
        _tasks: [{ execute: dynamicExecute, _renderables: [{}], _pendingMeshes: [] }],
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
        const dynamicExecutes = [vi.fn(() => 1), vi.fn(() => 1), vi.fn(() => 1)];
        const scene = { camera: { key: 1 }, _renderableVersion: 7 };
        const caster = { worldMatrixVersion: 1, thinInstances: null };
        const gate = createCsmRefitGate<typeof caster>({ refitAngle: 0.05, refitMaxIntervalMs: 0, demoteQuietFrames: 2 });
        const state = {
            _scene: scene,
            _cameras: [{}, {}, {}],
            _uboData: new Float32Array(80),
            _casterMeshes: [caster],
            _staticTasks: staticExecutes.map((execute) => ({ execute })),
            _tasks: dynamicExecutes.map((execute) => ({ execute, _renderables: [{}], _pendingMeshes: [] })),
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
        const dynamicCalls = () => dynamicExecutes.map((fn) => fn.mock.calls.length);
        return { render, scene, sg, state, copy, staticCalls, dynamicCalls };
    }

    it("re-renders one static cascade per frame after a drift refit, none of them later than maxLagFrames", () => {
        const h = makeSpreadHarness(1);
        const base = h.staticCalls();
        const dynamicBase = h.dynamicCalls();
        const copies = h.copy.mock.calls.length;
        h.sg._light.direction.x = 0.2; // angle epsilon crossed: a drift-only refit
        expect(h.render()).toBeGreaterThan(0);
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]!, base[2]!]); // refit frame: cascade 0 only
        expect(h.dynamicCalls()).toEqual([dynamicBase[0]! + 1, dynamicBase[1]!, dynamicBase[2]!]);
        expect(h.copy.mock.calls[copies]![0].origin.z).toBe(0);
        expect(h.copy.mock.calls[copies]![2].depthOrArrayLayers).toBe(1);
        expect(h.render()).toBeGreaterThan(0); // nothing dynamic changed, yet the pending cascade keeps the frame alive
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]!]);
        expect(h.dynamicCalls()).toEqual([dynamicBase[0]! + 1, dynamicBase[1]! + 1, dynamicBase[2]!]);
        h.render();
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]); // lag 2 = maxLagFrames(3, 1)
        expect(h.dynamicCalls()).toEqual([dynamicBase[0]! + 1, dynamicBase[1]! + 1, dynamicBase[2]! + 1]);
        expect(h.copy.mock.calls.length).toBe(copies + 3); // one layer copy on each of the three frames
        expect(h.render()).toBe(0); // drained and quiet: the frame does nothing again
        expect(h.staticCalls()).toEqual([base[0]! + 1, base[1]! + 1, base[2]! + 1]);
    });

    it("publishes each receiver transform only with the matching refreshed depth layer", () => {
        const h = makeSpreadHarness(1);
        expect(h.state._uboData[0]).toBeCloseTo(1);
        expect(h.state._uboData[16]).toBeCloseTo(2);
        expect(h.state._uboData[32]).toBeCloseTo(3);

        h.sg._light.direction.x = 0.2;
        h.render();
        expect(h.state._uboData[0]).toBeCloseTo(1.2);
        expect(h.state._uboData[16]).toBeCloseTo(2);
        expect(h.state._uboData[32]).toBeCloseTo(3);

        h.render();
        expect(h.state._uboData[0]).toBeCloseTo(1.2);
        expect(h.state._uboData[16]).toBeCloseTo(2.2);
        expect(h.state._uboData[32]).toBeCloseTo(3);
    });

    it("does not begin an empty dynamic-overlay pass while a spread drains", () => {
        const h = makeSpreadHarness(1);
        const dynamicBase = h.dynamicCalls();
        h.state._tasks[0]!._renderables.length = 0;
        h.sg._light.direction.x = 0.2;
        h.render();
        expect(h.dynamicCalls()).toEqual(dynamicBase);
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

describe("renderCsmShadowMapCached spread static refit: a drift refit during the drain", () => {
    it("re-renders every cascade when a second drift refit lands before the spread drained (no permanent lag)", () => {
        // A light turning faster than the drain (a fast game clock) crosses the angle epsilon every frame: each
        // such refit must fall back to the single-frame re-render instead of re-arming a spread that never ends.
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
            _tasks: [
                { execute: dynamicExecute, _renderables: [{}], _pendingMeshes: [] },
                { execute: dynamicExecute, _renderables: [{}], _pendingMeshes: [] },
                { execute: dynamicExecute, _renderables: [{}], _pendingMeshes: [] },
            ],
            _gate: gate,
            _staticScheduler: createCsmStaticRefitScheduler(3, 1),
            _onPromote: () => {},
            _onDemote: () => {},
            _pendingTransfers: new Set(),
            _cachedContentVersion: -1,
            _lastCamVersion: -1,
            _lastCamAspect: -1,
        };
        const engine = { _device: { queue: { writeBuffer: vi.fn() } }, _currentEncoder: { copyTextureToTexture: vi.fn() } };
        const sg = { _light: { direction: { x: 0, y: -1, z: 0 } }, _shadowUBO: {}, _version: 0, _depthTexture: {} };
        const cfg = { _numCascades: 3, _mapSize: 4, _bias: 0, _worldSpaceBias: null, _forceRefreshEveryFrame: false };
        const render = () => renderCsmShadowMapCached(engine as any, sg as any, state as any, cfg as any);
        const calls = () => staticExecutes.map((fn) => fn.mock.calls.length);
        render();
        render();
        render();
        scene.camera.key++;
        render(); // settled: the caster is static, the next refits are drift-only
        const base = calls();
        sg._light.direction.x = 0.2; // drift refit #1: spread, cascade 0 only
        render();
        expect(calls()).toEqual([base[0]! + 1, base[1]!, base[2]!]);
        sg._light.direction.x = 0.4; // drift refit #2 while cascades 1 and 2 still wait: everything, this frame
        render();
        expect(calls()).toEqual([base[0]! + 2, base[1]! + 1, base[2]! + 1]);
        expect(render()).toBe(0); // nothing pending, nothing dynamic: the frame does nothing
        sg._light.direction.x = 0.6; // and with the drain complete, the next drift refit spreads again: ONE cascade
        render(); // (the round-robin cursor decides which one — it continues after the last cascade taken)
        const after = calls();
        expect(after.reduce((sum, n) => sum + n, 0)).toBe(base[0]! + base[1]! + base[2]! + 5); // +1, +3, then +1
        expect(after.filter((n, i) => n === [base[0]! + 2, base[1]! + 1, base[2]! + 1][i]! + 1)).toHaveLength(1);
    });
});
