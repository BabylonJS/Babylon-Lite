import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { setShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import {
    _prepareAsyncShaderPipelinesForScene,
    _registerAsyncShaderPipelineRecipe,
    enableAsyncShaderPipelineCompilation,
    prepareShaderMaterialPipeline,
    prepareShaderMaterialPipelineForTask,
} from "../../../packages/babylon-lite/src/material/shader/enable-async-shader-pipeline-compilation";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { buildShaderRenderablesWithInstancing } from "../../../packages/babylon-lite/src/material/shader/shader-thin-instance";
import type { ShaderPacket } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUShaderStage"> & {
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
};
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;

function makeEngine(createAsync?: (descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline>) {
    const createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout);
    const createPipelineLayout = vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout);
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
    const createRenderPipelineAsync = vi.fn(createAsync ?? (async (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline));
    const device = {
        createBindGroupLayout,
        createPipelineLayout,
        createShaderModule,
        createRenderPipeline,
        createRenderPipelineAsync,
    } as unknown as GPUDevice;
    const engine = { _device: device } as unknown as EngineContext;
    return { engine, createShaderModule, createRenderPipeline, createRenderPipelineAsync };
}

function makeMaterial() {
    return createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
        attributes: ["position"],
    });
}

const signature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus",
    _sampleCount: 1,
} as RenderTargetSignature;

function targetTask(engine?: EngineContext): RenderTask {
    return { _renderables: [], _targetSignature: signature, engine } as unknown as RenderTask;
}

function layoutArgs(layout: "mesh" | "thin-instances" | "thin-instances-color", bindings: ReturnType<typeof getOrCreateShaderPipelineBindings>) {
    if (layout === "mesh") {
        return { variantKey: "", vertexBuffers: bindings.vertexBuffers, instanceAttrs: "" };
    }
    const hasColor = layout === "thin-instances-color";
    const instanceLayouts: GPUVertexBufferLayout[] = [
        {
            arrayStride: 64,
            stepMode: "instance",
            attributes: [
                { shaderLocation: 1, offset: 0, format: "float32x4" },
                { shaderLocation: 2, offset: 16, format: "float32x4" },
                { shaderLocation: 3, offset: 32, format: "float32x4" },
                { shaderLocation: 4, offset: 48, format: "float32x4" },
            ],
        },
    ];
    let instanceAttrs = `@location(1) world0: vec4<f32>,
@location(2) world1: vec4<f32>,
@location(3) world2: vec4<f32>,
@location(4) world3: vec4<f32>,
`;
    if (hasColor) {
        instanceLayouts.push({
            arrayStride: 16,
            stepMode: "instance",
            attributes: [{ shaderLocation: 5, offset: 0, format: "float32x4" }],
        });
        instanceAttrs += `@location(5) instanceColor: vec4<f32>,
`;
    }
    return { variantKey: "" + +hasColor, vertexBuffers: [...bindings.vertexBuffers, ...instanceLayouts], instanceAttrs };
}

describe("async ShaderMaterial pipeline compilation", () => {
    it("is inert until enabled and enabling is idempotent", async () => {
        const { engine, createRenderPipelineAsync } = makeEngine();
        const material = makeMaterial();
        const renderable = {} as Renderable;
        const scene = {
            surface: { engine },
            _frameGraph: { _tasks: [] },
            _renderables: [],
            lights: [],
        } as unknown as SceneContext;

        _registerAsyncShaderPipelineRecipe(scene, material, renderable);
        await _prepareAsyncShaderPipelinesForScene(scene);
        expect(createRenderPipelineAsync).not.toHaveBeenCalled();

        enableAsyncShaderPipelineCompilation(engine);
        enableAsyncShaderPipelineCompilation(engine);
        const task = {
            scene,
            _renderables: [renderable],
            _pendingMeshes: [],
            _targetSignature: signature,
            _config: { autoMirror: false },
        } as unknown as RenderTask;
        scene._frameGraph._tasks.push(task);
        _registerAsyncShaderPipelineRecipe(scene, material, renderable);
        await _prepareAsyncShaderPipelinesForScene(scene);

        expect(createRenderPipelineAsync).toHaveBeenCalledOnce();
    });

    it("deduplicates concurrent preparation before creating shader modules", async () => {
        clearSceneBGLCache();
        let resolveCreation!: (pipeline: GPURenderPipeline) => void;
        const creation = new Promise<GPURenderPipeline>((resolve) => (resolveCreation = resolve));
        const { engine, createShaderModule, createRenderPipelineAsync } = makeEngine(() => creation);
        const material = makeMaterial();
        const task = targetTask(engine);

        const first = prepareShaderMaterialPipeline(engine, material, "mesh", task);
        const second = prepareShaderMaterialPipeline(engine, material, "mesh", task);

        expect(createShaderModule).toHaveBeenCalledTimes(2);
        expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);

        resolveCreation({} as GPURenderPipeline);
        await Promise.all([first, second]);
    });

    it("deduplicates concurrent preparation with the cross-material cache", async () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        let resolveCreation!: (pipeline: GPURenderPipeline) => void;
        const creation = new Promise<GPURenderPipeline>((resolve) => (resolveCreation = resolve));
        const { engine, createShaderModule, createRenderPipelineAsync } = makeEngine(() => creation);
        const material = makeMaterial();
        enableShaderPipelineCache(engine, [{ material }]);
        const task = targetTask(engine);

        const first = prepareShaderMaterialPipeline(engine, material, "mesh", task);
        const second = prepareShaderMaterialPipeline(engine, material, "mesh", task);

        expect(createShaderModule).toHaveBeenCalledTimes(2);
        expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);

        resolveCreation({} as GPURenderPipeline);
        await Promise.all([first, second]);
    });

    it.each(["mesh", "thin-instances", "thin-instances-color"] as const)("uses the prepared key and synchronous descriptor for the %s layout", async (layoutName) => {
        clearSceneBGLCache();
        const prepared = makeEngine();
        const material = makeMaterial();
        const task = targetTask(prepared.engine);

        await prepareShaderMaterialPipeline(prepared.engine, material, layoutName, task);
        const bindings = getOrCreateShaderPipelineBindings(prepared.engine, material);
        const layout = layoutArgs(layoutName, bindings);
        const pipeline = getOrCreateShaderPipeline(prepared.engine, signature, material, bindings, layout.variantKey, layout.vertexBuffers, layout.instanceAttrs);
        const asyncPipeline = await prepared.createRenderPipelineAsync.mock.results[0]!.value;

        expect(pipeline).toBe(asyncPipeline);
        expect(prepared.createRenderPipeline).not.toHaveBeenCalled();

        clearSceneBGLCache();
        const synchronous = makeEngine();
        const syncMaterial = makeMaterial();
        const syncBindings = getOrCreateShaderPipelineBindings(synchronous.engine, syncMaterial);
        const syncLayout = layoutArgs(layoutName, syncBindings);
        getOrCreateShaderPipeline(synchronous.engine, signature, syncMaterial, syncBindings, syncLayout.variantKey, syncLayout.vertexBuffers, syncLayout.instanceAttrs);

        expect(prepared.createRenderPipelineAsync.mock.calls[0]![0]).toEqual(synchronous.createRenderPipeline.mock.calls[0]![0]);
    });

    it("uses RenderTarget attachment state and the task convenience API", async () => {
        clearSceneBGLCache();
        const { engine, createRenderPipelineAsync } = makeEngine();
        const material = makeMaterial();
        const target = createRenderTarget({
            format: "rgba16float",
            dFormat: "depth32float",
            _depthCompare: "less-equal",
            samples: 4,
            size: { width: 64, height: 64 },
        });

        await prepareShaderMaterialPipeline(engine, material, "mesh", target);
        const descriptor = createRenderPipelineAsync.mock.calls[0]![0];

        expect(descriptor.fragment?.targets).toEqual([{ format: "rgba16float" }]);
        expect(descriptor.depthStencil).toMatchObject({ format: "depth32float", depthCompare: "less-equal" });
        expect(descriptor.multisample).toEqual({ count: 4 });

        const second = makeEngine();
        await prepareShaderMaterialPipelineForTask(targetTask(second.engine), makeMaterial(), "mesh");
        expect(second.createRenderPipelineAsync).toHaveBeenCalledOnce();
    });

    it.each([false, true])("matches the actual thin-instance renderable layout when color is %s", async (hasColor) => {
        clearSceneBGLCache();
        const { engine, createRenderPipeline } = makeEngine();
        const material = makeMaterial();
        const mesh = {
            material,
            thinInstances: {
                count: 1,
                matrices: new Float32Array(16),
                colors: hasColor ? new Float32Array(4) : undefined,
            },
            worldMatrix: new Float32Array(16),
            _gpu: { indexCount: 3 },
        } as unknown as Mesh;
        const scene = { surface: { engine }, _renderables: [], lights: [] } as unknown as SceneContext;
        enableAsyncShaderPipelineCompilation(engine);
        const result = buildShaderRenderablesWithInstancing(
            scene,
            [mesh],
            () => ({ renderables: [], rebuildSingle: () => undefined as never }),
            (_scene, _material, _spec, packetMesh) => ({ mesh: packetMesh, _bindGroup: {} }) as unknown as ShaderPacket,
            () => undefined,
            () => undefined,
            () => ({}) as GPUBuffer,
            getOrCreateShaderPipeline,
            getOrCreateShaderPipelineBindings
        );
        _registerAsyncShaderPipelineRecipe(scene, material, mesh, hasColor ? "thin-instances-color" : "thin-instances");

        const task = {
            scene,
            _renderables: result.renderables,
            _pendingMeshes: [],
            _targetSignature: signature,
            _config: { autoMirror: false },
        } as unknown as RenderTask;
        Object.assign(scene, { _frameGraph: { _tasks: [task] }, _renderables: result.renderables });
        await _prepareAsyncShaderPipelinesForScene(scene);
        result.renderables[0]!.bind(engine, signature);

        expect(createRenderPipeline).not.toHaveBeenCalled();
    });

    it("traverses shadow task, cascade, and static-cache render tasks", async () => {
        clearSceneBGLCache();
        const { engine, createRenderPipelineAsync } = makeEngine();
        const material = makeMaterial();
        const renderables = [{}, {}, {}] as Renderable[];
        const scene = {
            surface: { engine },
            _renderables: [],
            lights: [],
        } as unknown as SceneContext;
        const formats = ["rgba8unorm", "bgra8unorm", "rgba16float"] as const;
        const nested = renderables.map(
            (renderable, index) =>
                ({
                    scene,
                    _renderables: [renderable],
                    _pendingMeshes: [],
                    _targetSignature: { ...signature, _colorFormat: formats[index]! },
                    _config: { autoMirror: false },
                }) as unknown as RenderTask
        );
        const ensureState = vi.fn(() => ({ _task: nested[0], _tasks: [nested[1]], _staticTasks: [nested[2]] }));
        const generator = { _ensureShadowTaskState: ensureState } as unknown as ShadowGenerator;
        setShadowTaskCasterMeshes(generator, [{} as Mesh]);
        generator._preloadPending = undefined;
        Object.assign(scene, {
            _frameGraph: { _tasks: [{ name: "shadow" }] },
            lights: [{ shadowGenerator: generator }],
        });

        enableAsyncShaderPipelineCompilation(engine);
        for (const renderable of renderables) {
            _registerAsyncShaderPipelineRecipe(scene, material, renderable);
        }
        await _prepareAsyncShaderPipelinesForScene(scene);

        expect(ensureState).toHaveBeenCalledOnce();
        expect(createRenderPipelineAsync).toHaveBeenCalledTimes(3);
    });

    it("does not materialize shadow state without the scene shadow task", async () => {
        const { engine } = makeEngine();
        const ensureState = vi.fn();
        const generator = { _ensureShadowTaskState: ensureState } as unknown as ShadowGenerator;
        setShadowTaskCasterMeshes(generator, [{} as Mesh]);
        generator._preloadPending = undefined;
        const scene = {
            surface: { engine },
            _frameGraph: { _tasks: [{ name: "scene" }] },
            _renderables: [],
            lights: [{ shadowGenerator: generator }],
        } as unknown as SceneContext;

        enableAsyncShaderPipelineCompilation(engine);
        await _prepareAsyncShaderPipelinesForScene(scene);

        expect(ensureState).not.toHaveBeenCalled();
    });

    it("cleans up a rejected preparation and preserves the synchronous fallback", async () => {
        clearSceneBGLCache();
        const failure = new Error("pipeline validation failed");
        const { engine, createRenderPipeline, createRenderPipelineAsync } = makeEngine(() => Promise.reject(failure));
        const material = makeMaterial();
        const task = targetTask(engine);

        await expect(prepareShaderMaterialPipeline(engine, material, "mesh", task)).rejects.toBe(failure);
        const bindings = getOrCreateShaderPipelineBindings(engine, material);
        expect(bindings._P?.size).toBe(0);

        const pipeline = getOrCreateShaderPipeline(engine, signature, material, bindings);
        expect(pipeline).toBeDefined();
        expect(createRenderPipelineAsync).toHaveBeenCalledOnce();
        expect(createRenderPipeline).toHaveBeenCalledOnce();
    });

    it("keeps automatic scene preparation best-effort when async creation rejects", async () => {
        clearSceneBGLCache();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const failure = new Error("pipeline validation failed");
        const { engine, createRenderPipeline } = makeEngine(() => Promise.reject(failure));
        const material = makeMaterial();
        const renderable = {} as Renderable;
        const task = {
            _renderables: [renderable],
            _pendingMeshes: [],
            _targetSignature: signature,
            _config: { autoMirror: false },
        } as unknown as RenderTask;
        const scene = {
            _frameGraph: { _tasks: [task] },
            _renderables: [renderable],
            lights: [],
        } as unknown as SceneContext;
        Object.assign(scene, { surface: { engine } });

        enableAsyncShaderPipelineCompilation(engine);
        _registerAsyncShaderPipelineRecipe(scene, material, renderable);
        await expect(_prepareAsyncShaderPipelinesForScene(scene)).resolves.toBeUndefined();

        expect(error).toHaveBeenCalledWith(expect.stringContaining("synchronous first-bind fallback"), failure);
        getOrCreateShaderPipeline(engine, signature, material, getOrCreateShaderPipelineBindings(engine, material));
        expect(createRenderPipeline).toHaveBeenCalledOnce();
        error.mockRestore();
    });

    it.each([
        ["plain", false],
        ["cross-material cache", true],
    ] as const)("rebuilds %s bindings, modules, and pipelines after a device switch", async (_name, cached) => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const first = makeEngine();
        const second = makeEngine();
        const material = makeMaterial();
        if (cached) {
            enableShaderPipelineCache(first.engine, [{ material }]);
        }

        await prepareShaderMaterialPipeline(first.engine, material, "mesh", targetTask(first.engine));
        const firstBindings = getOrCreateShaderPipelineBindings(first.engine, material);
        await prepareShaderMaterialPipeline(second.engine, material, "mesh", targetTask(second.engine));
        const secondBindings = getOrCreateShaderPipelineBindings(second.engine, material);

        expect(secondBindings).not.toBe(firstBindings);
        expect(first.createShaderModule).toHaveBeenCalledTimes(2);
        expect(second.createShaderModule).toHaveBeenCalledTimes(2);
        expect(first.createRenderPipelineAsync).toHaveBeenCalledOnce();
        expect(second.createRenderPipelineAsync).toHaveBeenCalledOnce();
    });
});
