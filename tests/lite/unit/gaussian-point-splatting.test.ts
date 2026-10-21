import { describe, expect, it, vi } from "vitest";
import { disableGaussianPointSplatting, enableGaussianPointSplatting } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gaussian-point-splatting.js";
import {
    GPS_REPROJECTION_SAMPLES,
    GPS_SOFT_RESET_SAMPLES,
    gpsAccumulatedSamples,
    gpsHiZLevels,
    gpsHistoryCap,
    gpsOptionsKey,
    gpsPointBudget,
    gpsPoisson,
    gpsRenderScale,
    gpsReprojectionSamples,
    gpsSoftReset,
    gpsUpdateGeneration,
} from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-state.js";
import type { GaussianSplattingMesh } from "../../../packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { GaussianSplatStream } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { GaussianPointSplatting } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-state.js";
import { multiplyMat4 } from "../../../packages/babylon-lite/src/math/multiply-mat4.js";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";
import { createPerspectiveMat4LH } from "../../../packages/babylon-lite/src/math/create-perspective-mat4-lh.js";

vi.mock("../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu.js", async (original) => ({
    ...(await original<object>()),
    getSplatStreamDrawBatch: vi.fn(() => ({ reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() })),
}));

function renderPass() {
    return { draw: vi.fn(), setVertexBuffer: vi.fn() } as unknown as GPURenderPassEncoder;
}

function fixture(built = false) {
    const engine = {} as EngineContext;
    const splatIndexBuffer = {} as GPUBuffer;
    const draws = vi.fn();
    const batches = [{ reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() }];
    const classic: Renderable = {
        order: 200,
        isTransparent: true,
        bind() {
            return {
                renderable: classic,
                pipeline: {} as GPURenderPipeline,
                update: vi.fn(),
                _updateBatches: batches,
                draw(pass) {
                    pass.setVertexBuffer(1, splatIndexBuffer);
                    pass.draw(6);
                    draws();
                    return 1;
                },
            };
        },
    };
    const mesh = { _kind: "gs-mesh", _gs: { _splatIndexBuffer: splatIndexBuffer }, updateData: vi.fn() } as unknown as GaussianSplattingMesh;
    const scene = {
        surface: { engine },
        _renderables: [classic],
        _renderableVersion: 0,
        _beforeRender: [],
        _disposables: [],
        _built: built,
    } as unknown as SceneContext;
    return { scene, mesh, engine, classic, draws, batches };
}

describe("Gaussian point splatting parameters", () => {
    it("packs mutually inverse reprojection transforms in column-major order", async () => {
        const { gpsReprojectionMatrix } = await import("../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js");
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const matrices = new Float32Array(48);
        for (let i = 0; i < 3; i++) {
            matrices.set(identity, i * 16);
        }
        matrices[0] = 2;
        matrices[12] = 3;
        matrices[29] = -4;
        matrices[32] = 2;
        matrices[37] = 3;
        const world = identity.slice();
        world[5] = 2;
        world[13] = 1;
        const view = identity.slice();
        view[12] = -2;
        const projection = identity.slice();
        projection[0] = 3;
        projection[5] = 4;
        const packed = gpsReprojectionMatrix(matrices, world as unknown as Mat4, view as unknown as Mat4, projection as unknown as Mat4)!;
        expect(packed).toHaveLength(48);
        expect(packed[0]).toBeCloseTo(0.75);
        expect(packed[5]).toBeCloseTo(8 / 3);
        expect(packed[12]).toBeCloseTo(-10.5);
        expect(packed[13]).toBeCloseTo(36);
        const forward = packed.subarray(0, 16) as unknown as Mat4;
        const backward = packed.subarray(16, 32) as unknown as Mat4;
        for (const product of [multiplyMat4(forward, backward), multiplyMat4(backward, forward)]) {
            Array.from(product).forEach((value, i) => expect(value).toBeCloseTo(identity[i]!, 5));
        }
        Array.from(multiplyMat4(projection as unknown as Mat4, packed.subarray(32, 48) as unknown as Mat4)).forEach((value, i) => expect(value).toBeCloseTo(identity[i]!, 5));
    });

    it.each(["finite", "infinite", "orthographic", "off-axis"] as const)("reconstructs actual current view depth with a %s projection", async (kind) => {
        const { gpsReprojectionMatrix } = await import("../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js");
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const projection = new Float32Array(createPerspectiveMat4LH(Math.PI / 2, 1, 0.1, 100));
        if (kind === "infinite") {
            projection[10] = 0;
            projection[14] = 0.1;
        } else if (kind === "orthographic") {
            projection.set(identity);
            projection[10] = -1 / 99.9;
            projection[14] = 100 / 99.9;
        } else if (kind === "off-axis") {
            projection[8] = 0.2;
            projection[9] = -0.3;
            projection[2] = 0.01;
        }
        const matrices = new Float32Array(48);
        matrices.set(identity);
        matrices.set(identity, 16);
        matrices.set(projection, 32);
        const view = identity.slice();
        view[12] = 0.25;
        view[14] = 1;
        const packed = gpsReprojectionMatrix(matrices, identity as unknown as Mat4, view as unknown as Mat4, projection as unknown as Mat4)!;
        const transform = (matrix: ArrayLike<number>, vector: number[]): number[] =>
            Array.from({ length: 4 }, (_, row) => vector.reduce((sum, value, col) => sum + matrix[col * 4 + row]! * value, 0));
        for (const depth of [2, 10]) {
            const previous = transform(projection, [0.2, -0.1, depth, 1]);
            const clip = transform(
                packed,
                previous.map((value) => value / previous[3]!)
            );
            const currentView = transform(packed.subarray(32, 48), clip);
            expect(currentView[2]! / currentView[3]!).toBeCloseTo(depth + 1, 3);
            if (kind !== "orthographic") {
                expect(clip[3]).toBeCloseTo((depth + 1) / depth);
                expect(clip[3]).not.toBeCloseTo(depth + 1);
            }
        }
    });

    it.each([NaN, Infinity, -Infinity])("rejects non-finite reprojection transforms (%s)", async (value) => {
        const { gpsReprojectionMatrix } = await import("../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js");
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const matrices = new Float32Array(48);
        for (let i = 0; i < 3; i++) {
            matrices.set(identity, i * 16);
        }
        const view = identity.slice();
        view[12] = value;
        expect(gpsReprojectionMatrix(matrices, identity as unknown as Mat4, view as unknown as Mat4, identity as unknown as Mat4)).toBeNull();
    });

    it.each(["previous", "world", "view", "projection"] as const)("rejects singular %s reprojection transforms", async (singular) => {
        const { gpsReprojectionMatrix } = await import("../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js");
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const matrices = new Float32Array(48);
        for (let i = 0; i < 3; i++) {
            matrices.set(identity, i * 16);
        }
        const current = { world: identity.slice(), view: identity.slice(), projection: identity.slice() };
        if (singular === "previous") {
            matrices.fill(0, 0, 16);
        } else {
            current[singular].fill(0);
        }
        expect(gpsReprojectionMatrix(matrices, current.world as unknown as Mat4, current.view as unknown as Mat4, current.projection as unknown as Mat4)).toBeNull();
    });

    it("chooses ceil(sqrt(points/budget)), bounded to 1..8", () => {
        expect(gpsRenderScale(0, 15_000_000)).toBe(1);
        expect(gpsRenderScale(15_000_000, 15_000_000)).toBe(1);
        expect(gpsRenderScale(15_000_001, 15_000_000)).toBe(2);
        expect(gpsRenderScale(60_000_000, 15_000_000)).toBe(2);
        expect(gpsRenderScale(60_000_001, 15_000_000)).toBe(3);
        expect(gpsRenderScale(1e20, 6_000_000)).toBe(8);
    });

    it("refines the auto render scale only once the estimate clearly drops", () => {
        expect(gpsRenderScale(15_000_001, 15_000_000, 1)).toBe(2);
        expect(gpsRenderScale(14_000_000, 15_000_000, 2)).toBe(2);
        expect(gpsRenderScale(8_000_000, 15_000_000, 2)).toBe(1);
        expect(gpsRenderScale(1e20, 15_000_000, 9)).toBe(8);
    });

    it("tracks convergence, history caps and phase-preserving soft resets", () => {
        expect(gpsAccumulatedSamples(0, 4, 255)).toBe(0);
        expect(gpsAccumulatedSamples(7, 4, 255)).toBe(1);
        expect(gpsAccumulatedSamples(4 * 300, 4, 255)).toBe(255);
        expect(gpsHistoryCap(0, 4, 255)).toBe(1);
        expect(gpsHistoryCap(7, 4, 255)).toBe(2);
        expect(gpsHistoryCap(4 * 300, 4, 255)).toBe(254);
        expect(gpsHistoryCap(0, 4, 1)).toBe(0);
        expect(gpsHistoryCap(33, 4, 8)).toBe(7);
        const state = { key: "", generation: 0, frames: 4 * 100 + 3 };
        gpsSoftReset(state, 4);
        expect(state.frames).toBe(4 * GPS_SOFT_RESET_SAMPLES + 3);
        state.frames = 5;
        gpsSoftReset(state, 4);
        expect(state.frames).toBe(5);
        state.frames = 4 * 100 + 1;
        gpsSoftReset(state, 4, gpsReprojectionSamples(255));
        expect(state.frames).toBe(4 * GPS_REPROJECTION_SAMPLES + 1);
        expect(gpsReprojectionSamples(8)).toBe(7);
        expect(gpsReprojectionSamples(1)).toBe(0);
    });

    it("uses desktop, iOS and mobile budgets, including desktop-mode iPads", () => {
        expect(gpsPointBudget("Windows Chrome")).toBe(15_000_000);
        expect(gpsPointBudget("iPhone Safari")).toBe(9_000_000);
        expect(gpsPointBudget("Macintosh Safari", 5)).toBe(9_000_000);
        expect(gpsPointBudget("Android Chrome Mobile")).toBe(6_000_000);
    });

    it("samples the low-mean Poisson CDF and preserves large-mean asymptotics", () => {
        expect(gpsPoisson(0, 0.9)).toBe(0);
        expect(gpsPoisson(1, 0.1)).toBe(0);
        expect(gpsPoisson(1, 0.5)).toBe(1);
        expect(gpsPoisson(1, 0.9)).toBe(2);
        expect(gpsPoisson(100, 0.5, 0)).toBe(100);
        let mean = 0;
        for (let i = 0; i < 10_000; i++) {
            mean += gpsPoisson(3, (i + 0.5) / 10_000);
        }
        expect(mean / 10_000).toBeCloseTo(3, 2);
    });

    it("packs odd-sized Hi-Z levels without dropping the trailing pixels", () => {
        expect(gpsHiZLevels(7, 3)).toEqual([
            { offset: 0, width: 7, height: 3 },
            { offset: 21, width: 3, height: 1 },
            { offset: 24, width: 1, height: 1 },
        ]);
        expect(gpsHiZLevels(1, 1)).toEqual([{ offset: 0, width: 1, height: 1 }]);
        expect(() => gpsHiZLevels(0, 1)).toThrow(RangeError);
    });

    it("resets once for each effective input change and wraps the packed generation", () => {
        const state = { key: "", generation: 65535, frames: 21 };
        expect(gpsUpdateGeneration(state, "view/size/options/content")).toBe(true);
        expect(state).toEqual({ key: "view/size/options/content", generation: 0, frames: 0 });
        state.frames++;
        expect(gpsUpdateGeneration(state, state.key)).toBe(false);
        expect(state.frames).toBe(1);
        expect(gpsUpdateGeneration(state, "changed")).toBe(true);
        expect(state.generation).toBe(1);
    });

    it("includes every mutable option in invalidation and rejects invalid values", () => {
        const { scene, mesh } = fixture();
        const gps = enableGaussianPointSplatting(scene, mesh);
        const original = gpsOptionsKey(gps);
        const patches: Partial<GaussianPointSplatting>[] = [
            { colorRenderMode: false },
            { depthRenderMode: true },
            { depthVisualization: "linear" },
            { depthVisualization: "alphaBlended" },
            { pointScale: 0.5 },
            { renderScale: 2 },
            { occlusionCulling: true },
            { temporalReprojection: true },
        ];
        for (const patch of patches) {
            expect(gpsOptionsKey({ ...gps, ...patch })).not.toBe(original);
        }
        expect(gpsOptionsKey({ ...gps, maxAccumFrames: 64 })).toBe(original);
        expect(() => gpsOptionsKey({ ...gps, pointScale: NaN })).toThrow(RangeError);
        expect(() => gpsOptionsKey({ ...gps, renderScale: 0 })).toThrow(RangeError);
        expect(() => gpsOptionsKey({ ...gps, maxAccumFrames: 65536 })).toThrow(RangeError);
        expect(() => gpsOptionsKey({ ...gps, depthVisualization: "invalid" as GaussianPointSplatting["depthVisualization"] })).toThrow(RangeError);
        disableGaussianPointSplatting(scene, gps);
    });
});

describe("Gaussian point splatting lifecycle without a GPU", () => {
    it.each([false, true])("enables and restores a static target with registered=%s", (built) => {
        const { scene, mesh, engine, classic, draws, batches } = fixture(built);
        const bind = classic.bind;
        const updateData = mesh.updateData;
        const gps = enableGaussianPointSplatting(scene, mesh);
        expect(gps).toMatchObject({
            colorRenderMode: true,
            depthRenderMode: false,
            depthVisualization: "none",
            pointScale: 1,
            renderScale: "auto",
            occlusionCulling: false,
            maxAccumFrames: 255,
            temporalReprojection: false,
        });
        expect(gps.progress).toBeNull();
        expect(scene._renderables).toHaveLength(2);
        const binding = classic.bind(engine, {} as RenderTargetSignature);
        expect(binding._updateBatches).toBe(batches);
        const pass = renderPass();
        expect(binding.draw(pass, engine)).toBe(0);
        expect(pass.draw).not.toHaveBeenCalled();
        expect(draws).toHaveBeenCalledOnce();
        mesh.updateData(new ArrayBuffer(0));
        expect(gps._dataVersion).toBe(1);
        expect(updateData).toHaveBeenCalledOnce();
        gps.colorRenderMode = false;
        expect(binding.draw(pass, engine)).toBe(1);
        expect(pass.draw).toHaveBeenCalledOnce();
        expect(enableGaussianPointSplatting(scene, mesh, { pointScale: 2 })).toBe(gps);
        expect(gps.pointScale).toBe(2);
        disableGaussianPointSplatting(scene, gps);
        expect(scene._renderables).toEqual([classic]);
        expect(scene._beforeRender).toHaveLength(0);
        expect(scene._disposables).toHaveLength(0);
        expect(classic.bind).toBe(bind);
        expect(mesh.updateData).toBe(updateData);
        disableGaussianPointSplatting(scene, gps);
        expect(scene._renderables).toHaveLength(1);
        expect(binding.draw(pass, engine)).toBe(1);
        expect(pass.draw).toHaveBeenCalledTimes(2);
    });

    it("discovers static renderables created during registration and on later frames", () => {
        const { scene, mesh, engine, classic } = fixture();
        scene._renderables.length = 0;
        const original = classic.bind;
        const gps = enableGaussianPointSplatting(scene, mesh);
        expect(classic.bind).toBe(original);
        scene._renderables.push(classic);
        scene._beforeRender.forEach((hook) => hook(0));
        expect(classic.bind).not.toBe(original);
        const pass = renderPass();
        expect(classic.bind(engine, {} as RenderTargetSignature).draw(pass, engine)).toBe(0);
        expect(pass.draw).not.toHaveBeenCalled();
        const replacement = { ...classic, bind: original };
        scene._renderables.splice(scene._renderables.indexOf(classic), 1, replacement);
        scene._beforeRender.forEach((hook) => hook(0));
        expect(classic.bind).toBe(original);
        expect(replacement.bind(engine, {} as RenderTargetSignature).draw(pass, engine)).toBe(0);
        disableGaussianPointSplatting(scene, gps);
        expect(replacement.bind).toBe(original);
    });

    it("identifies non-targets, restores their original binding and does not rewrap them", () => {
        const { scene, mesh, engine } = fixture();
        const other = fixture().classic;
        const original = other.bind;
        scene._renderables.push(other);
        const gps = enableGaussianPointSplatting(scene, mesh);
        expect(other.bind).not.toBe(original);
        const binding = other.bind(engine, {} as RenderTargetSignature);
        const pass = renderPass();
        const version = scene._renderableVersion;
        expect(binding.draw(pass, engine)).toBe(1);
        expect(pass.draw).toHaveBeenCalledOnce();
        expect(other.bind).toBe(original);
        expect(scene._renderableVersion).toBeGreaterThan(version);
        scene._beforeRender.forEach((hook) => hook(0));
        expect(other.bind).toBe(original);
        expect(binding.draw(pass, engine)).toBe(1);
        disableGaussianPointSplatting(scene, gps);
    });

    it("discovers targets with color off, preserves non-candidates, and responds to toggles", () => {
        const { scene, mesh, engine, classic } = fixture();
        const opaque = { ...fixture().classic, isTransparent: false };
        const differentOrder = { ...fixture().classic, order: 100 };
        const originals = [opaque.bind, differentOrder.bind];
        scene._renderables.push(opaque, differentOrder);
        const gps = enableGaussianPointSplatting(scene, mesh, { colorRenderMode: false, depthVisualization: "alphaBlended" });
        expect([opaque.bind, differentOrder.bind]).toEqual(originals);
        expect(gps.depthVisualization).toBe("alphaBlended");
        const binding = classic.bind(engine, {} as RenderTargetSignature);
        const pass = renderPass();
        expect(binding.draw(pass, engine)).toBe(1);
        gps.colorRenderMode = true;
        expect(binding.draw(pass, engine)).toBe(0);
        expect(pass.draw).toHaveBeenCalledOnce();
        disableGaussianPointSplatting(scene, gps);
    });

    it.each(["pass", "bundle"])("forwards native receivers and caches a proxy per %s encoder while suppressing every draw command", (kind) => {
        const { scene, mesh, engine, classic } = fixture();
        const seen: (GPURenderPassEncoder | GPURenderBundleEncoder)[] = [];
        const native = renderPass();
        const second = renderPass();
        const checkReceiver = vi.fn(function (this: GPURenderPassEncoder) {
            expect(this === native || this === second).toBe(true);
        });
        Object.assign(native, { setVertexBuffer: checkReceiver, setBindGroup: checkReceiver, drawIndexed: vi.fn(), drawIndirect: vi.fn(), drawIndexedIndirect: vi.fn() });
        Object.assign(second, { setVertexBuffer: checkReceiver, setBindGroup: checkReceiver, drawIndexed: vi.fn(), drawIndirect: vi.fn(), drawIndexedIndirect: vi.fn() });
        for (const encoder of [native, second]) {
            Object.defineProperty(encoder, "label", {
                get() {
                    expect(this).toBe(encoder);
                    return kind;
                },
            });
        }
        const original = classic.bind;
        classic.bind = function (boundEngine, signature) {
            expect(this).toBe(classic);
            const binding = original.call(this, boundEngine, signature);
            binding.draw = function (pass) {
                expect(this).toBe(binding);
                seen.push(pass);
                expect(pass.label).toBe(kind);
                pass.setVertexBuffer(1, mesh._gs._splatIndexBuffer);
                pass.setBindGroup(1, {} as GPUBindGroup);
                pass.draw(6);
                pass.drawIndexed(6);
                pass.drawIndirect({} as GPUBuffer, 0);
                pass.drawIndexedIndirect({} as GPUBuffer, 0);
                return 4;
            };
            return binding;
        };
        const gps = enableGaussianPointSplatting(scene, mesh);
        const binding = classic.bind(engine, {} as RenderTargetSignature);
        for (const pass of [native, second, native]) {
            expect(binding.draw(pass, engine)).toBe(0);
            expect(pass.draw).not.toHaveBeenCalled();
            expect(pass.drawIndexed).not.toHaveBeenCalled();
            expect(pass.drawIndirect).not.toHaveBeenCalled();
            expect(pass.drawIndexedIndirect).not.toHaveBeenCalled();
        }
        expect(seen[0]).toBe(seen[2]);
        expect(seen[0]).not.toBe(native);
        expect(seen[0]).not.toBe(seen[1]);
        expect(checkReceiver).toHaveBeenCalledTimes(6);
        disableGaussianPointSplatting(scene, gps);
    });

    it("shares discovery across targets and restores each cached binding independently", () => {
        const { scene, mesh, engine, classic } = fixture();
        const other = fixture();
        scene._renderables.push(other.classic);
        const originals = [classic.bind, other.classic.bind];
        const first = enableGaussianPointSplatting(scene, mesh);
        const second = enableGaussianPointSplatting(scene, other.mesh);
        expect(scene._beforeRender).toHaveLength(1);
        const bindings = [classic, other.classic].map((value) => value.bind(engine, {} as RenderTargetSignature));
        const pass = renderPass();
        expect(bindings.map((binding) => binding.draw(pass, engine))).toEqual([0, 0]);
        disableGaussianPointSplatting(scene, first);
        expect(classic.bind).toBe(originals[0]);
        expect(bindings.map((binding) => binding.draw(pass, engine))).toEqual([1, 0]);
        disableGaussianPointSplatting(scene, second);
        expect(other.classic.bind).toBe(originals[1]);
        expect(bindings.map((binding) => binding.draw(pass, engine))).toEqual([1, 1]);
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("wraps a deferred stream attachment before its first frame, retaining bootstrap and batch work", () => {
        const { scene, engine, classic, draws, batches } = fixture();
        const stream = { _engine: engine, _disposed: false, _renderable: null } as unknown as GaussianSplatStream;
        const bind = classic.bind;
        const gps = enableGaussianPointSplatting(scene, stream);
        stream._renderable = classic;
        scene._beforeRender.forEach((hook) => hook(0));
        expect(classic.bind).not.toBe(bind);
        const binding = classic.bind(engine, {} as RenderTargetSignature);
        const pass = renderPass();
        binding.update?.({ targetWidth: 8, targetHeight: 8 });
        binding._updateBatches?.forEach((batch) => batch.flush(engine));
        binding.draw(pass, engine);
        expect(batches[0]!.flush).toHaveBeenCalledOnce();
        expect(draws).toHaveBeenCalledOnce();
        expect(pass.draw).not.toHaveBeenCalled();
        scene._disposables.slice().forEach((dispose) => dispose());
        expect(gps._disabled).toBe(true);
        expect(classic.bind).toBe(bind);
    });

    it("rejects cross-scene ownership and leaves invalid options side-effect free", () => {
        const { scene, mesh, classic } = fixture();
        expect(() => enableGaussianPointSplatting(scene, mesh, { renderScale: 9 })).toThrow(RangeError);
        expect(scene._renderables).toEqual([classic]);
        const gps = enableGaussianPointSplatting(scene, mesh);
        const other = fixture().scene;
        expect(() => enableGaussianPointSplatting(other, mesh)).toThrow(/another scene/);
        disableGaussianPointSplatting(other, gps);
        expect(gps._disabled).toBe(false);
        disableGaussianPointSplatting(scene, gps);
        expect(enableGaussianPointSplatting(scene, mesh)).not.toBe(gps);
        scene._disposables.slice().forEach((dispose) => dispose());
    });

    it("reuses view batches during binding refresh and retires their resources exactly once", () => {
        const { scene, mesh, engine } = fixture(true);
        const buffers: { destroy: ReturnType<typeof vi.fn> }[] = [];
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
            createBuffer: vi.fn(() => {
                const result = { destroy: vi.fn() };
                buffers.push(result);
                return result;
            }),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        } as unknown as GPUDevice;
        const gps = enableGaussianPointSplatting(scene, mesh);
        const renderable = scene._renderables[1]!;
        const signature = { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 } as RenderTargetSignature;
        const first = renderable.bind(engine, signature);
        const count = buffers.length;
        const next = renderable.bind(engine, signature);
        expect(next._updateBatches?.[0]).toBe(first._updateBatches?.[0]);
        expect(buffers).toHaveLength(count);
        disableGaussianPointSplatting(scene, gps);
        first._updateBatches?.[0]?.destroy();
        engine._retirements?.splice(0).forEach((dispose) => dispose());
        expect(buffers.every((value) => value.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("soft-resets streamed refreshes, skips stale gathers and stops once converged", () => {
        const { scene, engine } = fixture(true);
        const gpu = { count: 1, contentGeneration: 0, gatheredGeneration: 0, canonical: {}, intervals: [] };
        const stream = {
            _engine: engine,
            _disposed: false,
            _renderable: null,
            _gpu: gpu,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
        } as unknown as GaussianSplatStream;
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
            queue: { writeBuffer: vi.fn() },
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        } as unknown as GPUDevice;
        const beginComputePass = vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), dispatchWorkgroupsIndirect: vi.fn(), end: vi.fn() }));
        engine._currentEncoder = { beginComputePass, copyBufferToBuffer: vi.fn(), clearBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const gps = enableGaussianPointSplatting(scene, stream, { renderScale: 1, maxAccumFrames: 20 });
        const binding = scene._renderables[1]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const batch = binding._updateBatches![1]!;
        const context = { targetWidth: 16, targetHeight: 16, _camera: createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 }) };
        const frame = (): void => {
            batch.reset();
            binding.update!(context);
            batch.flush(engine);
        };
        const historyCap = (): number => {
            const writes = vi.mocked(engine._device.queue.writeBuffer).mock.calls;
            return (writes[writes.length - 1]![2] as Float32Array)[65]!;
        };
        for (let i = 0; i < 12; i++) {
            frame();
        }
        expect(gps.progress).toMatchObject({ accumulationVersion: 1, renderedFrameCount: 12, accumulatedSamples: 12 });
        gpu.contentGeneration = 1;
        let passes = beginComputePass.mock.calls.length;
        frame();
        expect(beginComputePass.mock.calls.length).toBe(passes);
        expect(gps.progress?.renderedFrameCount).toBe(12);
        gpu.gatheredGeneration = 1;
        frame();
        expect(historyCap()).toBe(GPS_SOFT_RESET_SAMPLES + 1);
        expect(gps.progress).toMatchObject({ accumulationVersion: 1, renderedFrameCount: GPS_SOFT_RESET_SAMPLES + 1 });
        for (let i = 0; i < 30; i++) {
            frame();
        }
        expect(gps.progress).toMatchObject({ accumulationVersion: 1, renderedFrameCount: 20, accumulatedSamples: 20 });
        passes = beginComputePass.mock.calls.length;
        frame();
        expect(beginComputePass.mock.calls.length).toBe(passes);
        expect(binding.draw({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() } as unknown as GPURenderPassEncoder, engine)).toBe(1);
        disableGaussianPointSplatting(scene, gps);
        engine._retirements?.splice(0).forEach((dispose) => dispose());
    });

    it.each(
        [1, 8, 9, 20].flatMap((limit) => [
            [limit, 1, 0],
            [limit, 2, 0],
            [limit, 2, 3],
        ])
    )("refreshes every streamed cycle slot before reconverging at limit=%s scale=%s phase=%s", (limit, renderScale, phase) => {
        const { scene, engine } = fixture(true);
        const gpu = { count: 1, contentGeneration: 0, gatheredGeneration: 0, canonical: {}, intervals: [] };
        const stream = {
            _engine: engine,
            _disposed: false,
            _renderable: null,
            _gpu: gpu,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
        } as unknown as GaussianSplatStream;
        const uploads: Float32Array[] = [];
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
            queue: {
                writeBuffer: vi.fn((_buffer, _offset, data: Float32Array) => {
                    if (data.length === 76) {
                        uploads.push(data.slice());
                    }
                }),
            },
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        } as unknown as GPUDevice;
        const beginComputePass = vi.fn(() => ({
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn(),
            dispatchWorkgroupsIndirect: vi.fn(),
            end: vi.fn(),
        }));
        engine._currentEncoder = { beginComputePass, copyBufferToBuffer: vi.fn(), clearBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const gps = enableGaussianPointSplatting(scene, stream, { renderScale, maxAccumFrames: limit + (phase > 0 ? 1 : 0), occlusionCulling: true });
        const binding = scene._renderables[1]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const batch = binding._updateBatches![1]!;
        const context = { targetWidth: 16, targetHeight: 16, _camera: createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 }) };
        const frame = (): void => {
            batch.reset();
            binding.update!(context);
            batch.flush(engine);
        };
        const cycle = renderScale * renderScale;
        for (let i = 0; i < limit * cycle + phase; i++) {
            frame();
        }
        gps.maxAccumFrames = limit;
        let passes = beginComputePass.mock.calls.length;
        frame();
        expect(beginComputePass.mock.calls.length).toBe(passes);
        expect(gps.progress).toMatchObject({ accumulatedSamples: limit, accumulationVersion: 1 });
        // A synchronized canonical update must resume compute even after a stationary view converged.
        for (let refresh = 1; refresh <= 2; refresh++) {
            const previousPhase = gps.progress!.renderedFrameCount % cycle;
            gpu.contentGeneration = gpu.gatheredGeneration = refresh;
            uploads.length = 0;
            for (let i = 0; i < cycle; i++) {
                passes = beginComputePass.mock.calls.length;
                frame();
                expect(beginComputePass.mock.calls.length).toBeGreaterThan(passes);
            }
            const slots = uploads.map((params) => params[72]! + renderScale * params[73]!);
            expect(new Set(slots).size).toBe(cycle);
            expect(slots[0]).toBe(previousPhase);
            expect(uploads.every((params) => params[65]! <= limit - 1)).toBe(true);
            expect(uploads.every((params) => params[67] === 0)).toBe(true);
            if (gps.progress!.accumulatedSamples < limit) {
                frame();
                expect(uploads.at(-1)![67]).toBe(1);
            }
            for (let i = 0; i < limit * cycle; i++) {
                frame();
            }
            expect(gps.progress).toMatchObject({ accumulatedSamples: limit, accumulationVersion: 1 });
            passes = beginComputePass.mock.calls.length;
            frame();
            expect(beginComputePass.mock.calls.length).toBe(passes);
        }
        disableGaussianPointSplatting(scene, gps);
        engine._retirements?.splice(0).forEach((dispose) => dispose());
    });

    it("reuses streamed working capacity while dispatching only active splats", () => {
        const { scene, engine } = fixture(true);
        const gpu = { count: 257, contentGeneration: 0, gatheredGeneration: 0, canonical: {}, intervals: [] };
        const stream = {
            _engine: engine,
            _disposed: false,
            _renderable: null,
            _gpu: gpu,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
        } as unknown as GaussianSplatStream;
        const allocations: { label: string; size: number; destroy: ReturnType<typeof vi.fn> }[] = [];
        const uploads: Float32Array[] = [];
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 4500 * 64 },
            queue: {
                writeBuffer: vi.fn((_buffer, _offset, data: Float32Array) => {
                    if (data.length === 76) {
                        uploads.push(data.slice());
                    }
                }),
            },
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const value = { label: descriptor.label!, size: descriptor.size, destroy: vi.fn() };
                allocations.push(value);
                return value;
            }),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => ({ label: descriptor.label, getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        } as unknown as GPUDevice;
        const dispatches: { label: string; x: number }[] = [];
        engine._currentEncoder = {
            beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => ({
                setPipeline: vi.fn(),
                setBindGroup: vi.fn(),
                dispatchWorkgroups: vi.fn((x: number) => dispatches.push({ label: descriptor.label!, x })),
                dispatchWorkgroupsIndirect: vi.fn(),
                end: vi.fn(),
            })),
            copyBufferToBuffer: vi.fn(),
            clearBuffer: vi.fn(),
        } as unknown as GPUCommandEncoder;
        const gps = enableGaussianPointSplatting(scene, stream, { renderScale: 1, maxAccumFrames: 1 });
        const binding = scene._renderables[1]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const batch = binding._updateBatches![1]!;
        const frame = (count: number): void => {
            gpu.count = count;
            gpu.gatheredGeneration = ++gpu.contentGeneration;
            dispatches.length = 0;
            batch.reset();
            binding.update!({ targetWidth: 16, targetHeight: 16, _camera: camera });
            batch.flush(engine);
            expect(uploads.at(-1)![60]).toBe(count);
            expect(engine._currentEncoder!.clearBuffer).toHaveBeenLastCalledWith(expect.objectContaining({ label: "GPS point count" }), 4, 4);
            expect(dispatches.filter(({ label }) => label === "GPS preprocess").map(({ x }) => x)).toEqual(count > 0 ? [Math.ceil(count / 256)] : []);
        };
        const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        frame(257);
        const workingBuffers = (): typeof allocations => allocations.filter(({ label }) => ["GPS weights", "GPS screen", "GPS CDF", "GPS block sums"].includes(label));
        const first = workingBuffers();
        expect(first.map(({ size }) => size)).toEqual([257 * 4, 257 * 64, 257 * 4, 8]);
        const groups = vi.mocked(engine._device.createBindGroup).mock.calls.length;
        frame(256);
        frame(0);
        frame(257);
        expect(workingBuffers()).toEqual(first);
        expect(engine._device.createBindGroup).toHaveBeenCalledTimes(groups);
        frame(258);
        expect(
            workingBuffers()
                .slice(-4)
                .map(({ size }) => size)
        ).toEqual([514 * 4, 514 * 64, 514 * 4, 12]);
        frame(513);
        expect(workingBuffers()).toHaveLength(8);
        frame(2500);
        expect(
            workingBuffers()
                .slice(-4)
                .map(({ size }) => size)
        ).toEqual([2500 * 4, 2500 * 64, 2500 * 4, 40]);
        frame(2501);
        expect(
            workingBuffers()
                .slice(-4)
                .map(({ size }) => size)
        ).toEqual([4500 * 4, 4500 * 64, 4500 * 4, 72]);
        frame(300);
        frame(4500);
        expect(workingBuffers()).toHaveLength(16);
        disableGaussianPointSplatting(scene, gps);
        engine._retirements?.splice(0).forEach((dispose) => dispose());
        expect(allocations.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
    });

    it.each([
        [false, 1],
        [true, 1],
        [false, 2],
        [true, 2],
    ] as const)("handles camera motion with temporalReprojection=%s and renderScale=%s", async (temporalReprojection, renderScale) => {
        const { scene, mesh, engine } = fixture(true);
        Object.assign(mesh, {
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            vertexCount: 1,
            textureWidth: 1,
            shDegree: 0,
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
            _gs: { _centersView: {}, _covAView: {}, _covBView: {}, _colorsView: {} },
        });
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
            queue: { writeBuffer: vi.fn() },
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => ({ label: descriptor.label, getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
        } as unknown as GPUDevice;
        const clearBuffer = vi.fn();
        const labels: string[] = [];
        engine._currentEncoder = {
            beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => {
                labels.push(descriptor.label!);
                return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), dispatchWorkgroupsIndirect: vi.fn(), end: vi.fn() };
            }),
            copyBufferToBuffer: vi.fn(),
            clearBuffer,
        } as unknown as GPUCommandEncoder;
        const gps = enableGaussianPointSplatting(scene, mesh, { renderScale, occlusionCulling: true, temporalReprojection });
        const cycle = renderScale * renderScale;
        const binding = scene._renderables[1]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const batch = binding._updateBatches![0]!;
        const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        const context = { targetWidth: 16, targetHeight: 16, _camera: camera };
        const frame = (): void => {
            batch.reset();
            binding.update!(context);
            batch.flush(engine);
        };
        const params = (): Float32Array => {
            const writes = vi.mocked(engine._device.queue.writeBuffer).mock.calls.filter((call) => (call[2] as Float32Array).length === 76);
            return writes[writes.length - 1]![2] as Float32Array;
        };
        if (temporalReprojection) {
            // The reprojection module loads lazily; once it arrives the accumulation restarts without the view in its key.
            frame();
            await vi.dynamicImportSettled();
            // Start from a known reset even when a previous case already loaded the module.
            gps.pointScale += 0.1;
        }
        for (let i = 0; i < 30 * cycle; i++) {
            frame();
            expect(params()[66]).not.toBe(2);
        }
        const version = gps.progress!.accumulationVersion;
        expect(gps.progress).toMatchObject({ accumulationVersion: temporalReprojection ? 2 : 1, renderedFrameCount: 30 * cycle });
        expect(params()[67]).toBe(1);
        labels.length = 0;
        camera.alpha += 0.05;
        frame();
        if (temporalReprojection) {
            expect(gps.progress).toMatchObject({ accumulationVersion: version, renderedFrameCount: GPS_REPROJECTION_SAMPLES * cycle + 1 });
            expect(labels.slice(0, 3)).toEqual(["GPS reproject nearest", "GPS reproject source", "GPS reproject gather"]);
            expect(clearBuffer).toHaveBeenCalledTimes(2);
            const reprojectionWrites = vi.mocked(engine._device.queue.writeBuffer).mock.calls.filter((call) => (call[2] as Float32Array).length === 52);
            expect(reprojectionWrites).toHaveLength(1);
            const reprojectionParams = reprojectionWrites[0]![2] as Float32Array;
            expect(Array.from(reprojectionParams.subarray(48))).toEqual([16, 16, version, GPS_REPROJECTION_SAMPLES]);
            const forward = reprojectionParams.subarray(0, 16) as unknown as Mat4;
            const backward = reprojectionParams.subarray(16, 32) as unknown as Mat4;
            Array.from(multiplyMat4(forward, backward)).forEach((value, i) => expect(value).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5));
            expect(engine._device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "GPS reprojection parameters", size: 208 }));
            expect(engine._currentEncoder!.copyBufferToBuffer).toHaveBeenCalledWith(expect.anything(), 0, expect.anything(), 0, 16 * 16 * 16);
            expect(params()[66]).toBe(2);
            expect(params()[67]).toBe(0);
            for (let i = 1; i <= cycle; i++) {
                frame();
                expect(params()[66]).toBe(i < cycle ? 2 : 0);
                expect(params()[67]).toBe(i < cycle ? 0 : 1);
            }
            expect(labels.filter((label) => label.startsWith("GPS reproject"))).toHaveLength(3);
            camera.alpha += 0.05;
            frame();
            expect(params()[66]).toBe(2);
            gps.pointScale += 0.1;
            frame();
            expect(params()[66]).toBe(1);
            frame();
            expect(params()[66]).toBe(0);
            const reprojectionPasses = labels.filter((label) => label.startsWith("GPS reproject")).length;
            const beforeSingular = gps.progress!.accumulationVersion;
            (mesh.worldMatrix as unknown as Float32Array).fill(0);
            frame();
            expect(gps.progress).toMatchObject({ accumulationVersion: beforeSingular + 1, renderedFrameCount: 1 });
            expect(params()[66]).toBe(1);
            expect(labels.filter((label) => label.startsWith("GPS reproject"))).toHaveLength(reprojectionPasses);
        } else {
            expect(gps.progress).toMatchObject({ accumulationVersion: version + 1, renderedFrameCount: 1 });
            expect(params()[66]).toBe(1);
            for (let i = 0; i < cycle; i++) {
                frame();
                expect(params()[66]).toBe(0);
            }
            expect(labels.some((label) => label.startsWith("GPS reproject"))).toBe(false);
            expect(clearBuffer).not.toHaveBeenCalled();
        }
        disableGaussianPointSplatting(scene, gps);
        engine._retirements?.splice(0).forEach((dispose) => dispose());
    });

    it("invalidates runtime accumulation for options, data, resize and reactivation", () => {
        const { scene, mesh, engine } = fixture(true);
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        Object.assign(mesh, {
            worldMatrix: identity,
            vertexCount: 1,
            textureWidth: 1,
            shDegree: 0,
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
            _gs: { _centersView: {}, _covAView: {}, _covBView: {}, _colorsView: {} },
        });
        const compositeDescriptors: GPURenderPipelineDescriptor[] = [];
        engine._device = {
            limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 },
            queue: { writeBuffer: vi.fn() },
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createShaderModule: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
            createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
                compositeDescriptors.push(descriptor);
                return { getBindGroupLayout: vi.fn(() => ({})) };
            }),
        } as unknown as GPUDevice;
        engine._currentEncoder = {
            beginComputePass: vi.fn(() => ({
                setPipeline: vi.fn(),
                setBindGroup: vi.fn(),
                dispatchWorkgroups: vi.fn(),
                dispatchWorkgroupsIndirect: vi.fn(),
                end: vi.fn(),
            })),
            copyBufferToBuffer: vi.fn(),
        } as unknown as GPUCommandEncoder;
        const gps = enableGaussianPointSplatting(scene, mesh, { renderScale: 1 });
        const binding = scene._renderables[1]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const batch = binding._updateBatches![0]!;
        const context = { targetWidth: 16, targetHeight: 16, _camera: createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 }) };
        const frame = (): void => {
            batch.reset();
            binding.update!(context);
            batch.flush(engine);
        };
        frame();
        expect(gps.progress?.accumulationVersion).toBe(1);
        frame();
        expect(gps.progress?.renderedFrameCount).toBe(2);
        gps.colorRenderMode = false;
        frame();
        gps.colorRenderMode = true;
        frame();
        expect(gps.progress?.accumulationVersion).toBe(2);
        gps.maxAccumFrames = 2;
        frame();
        const passes = vi.mocked(engine._currentEncoder.beginComputePass).mock.calls.length;
        frame();
        frame();
        expect(vi.mocked(engine._currentEncoder.beginComputePass).mock.calls.length).toBe(passes);
        expect(gps.progress).toMatchObject({ accumulationVersion: 2, renderedFrameCount: 2, accumulatedSamples: 2 });
        gps.maxAccumFrames = 3;
        frame();
        expect(vi.mocked(engine._currentEncoder.beginComputePass).mock.calls.length).toBeGreaterThan(passes);
        expect(gps.progress).toMatchObject({ accumulationVersion: 2, renderedFrameCount: 3, accumulatedSamples: 3 });
        gps.maxAccumFrames = 255;
        mesh.updateData(new ArrayBuffer(0));
        frame();
        expect(gps.progress?.accumulationVersion).toBe(3);
        context.targetWidth = 8;
        frame();
        expect(gps.progress?.accumulationVersion).toBe(4);
        expect(gps.progress?.renderedFrameCount).toBe(1);
        gps.colorRenderMode = false;
        gps.depthRenderMode = true;
        const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() } as unknown as GPURenderPassEncoder;
        for (const [i, mode] of (["none", "linear", "alphaBlended"] as const).entries()) {
            gps.depthVisualization = mode;
            frame();
            expect(gps.progress?.accumulationVersion).toBe(5 + i);
            expect(gps.progress?.renderedFrameCount).toBe(1);
            const writes = vi.mocked(engine._device.queue.writeBuffer).mock.calls;
            expect((writes[writes.length - 1]![2] as Float32Array)[71]).toBe(i);
            expect(binding.draw(pass, engine)).toBe(1);
            const descriptor = compositeDescriptors[compositeDescriptors.length - 1]!;
            expect([...descriptor.fragment!.targets][0]!.writeMask).toBe(mode === "none" ? 0 : 15);
        }
        disableGaussianPointSplatting(scene, gps);
        engine._retirements?.splice(0).forEach((dispose) => dispose());
    });
});
