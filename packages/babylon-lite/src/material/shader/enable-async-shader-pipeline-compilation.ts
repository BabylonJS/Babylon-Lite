import type { EngineContext } from "../../engine/engine.js";
import type { RenderTarget, RenderTargetSignature } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import type { RenderTask } from "../../frame-graph/render-task.js";
import { _resolvePendingMeshes } from "../../frame-graph/render-task.js";
import type { Renderable } from "../../render/renderable.js";
import { _getShadowTaskCasterMeshes } from "../../frame-graph/shadow-inputs.js";
import type { SceneContext } from "../../scene/scene-core.js";
import { _installAsyncShaderPipelinePreparation } from "../../scene/scene-core.js";
import { retargetShaderPipelineCache } from "./shader-pipeline-cache.js";
import { _resolveShaderPipelineVariantKey, getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings, type ShaderPipelineBindings } from "./shader-pipeline.js";
import type { ShaderMaterial } from "./shader-material.js";
import { _installAsyncShaderPipelineRegistrar } from "./shader-renderable.js";

/** Logical vertex-input layout for a ShaderMaterial pipeline. */
export type ShaderMaterialPipelineLayout = "mesh" | "thin-instances" | "thin-instances-color";

interface PrepareRecipe {
    readonly material: ShaderMaterial;
    readonly layout: ShaderMaterialPipelineLayout;
}

let _recipesByEngine: WeakMap<EngineContext, WeakMap<object, PrepareRecipe>> | null = null;

function isRenderTask(value: unknown): value is RenderTask {
    return typeof value === "object" && value !== null && "_renderables" in value && "_targetSignature" in value;
}

function nestedTasks(value: unknown): readonly unknown[] {
    if (typeof value !== "object" || value === null) {
        return [];
    }
    const state = value as { _task?: unknown; _tasks?: readonly unknown[]; _staticTasks?: readonly unknown[] };
    return [state._task, ...(state._tasks ?? []), ...(state._staticTasks ?? [])];
}

/**
 * Opt in to preparing ShaderMaterial render pipelines during scene registration.
 * The default synchronous pipeline path remains installed and is used for signatures
 * or renderables introduced after registration.
 */
export function enableAsyncShaderPipelineCompilation(engine: EngineContext): void {
    if (_recipesByEngine?.has(engine)) {
        return;
    }
    if (!_recipesByEngine) {
        _recipesByEngine = new WeakMap();
        _installAsyncShaderPipelineRegistrar(_registerAsyncShaderPipelineRecipe);
        _installAsyncShaderPipelinePreparation(_prepareAsyncShaderPipelinesForScene);
    }
    const recipes = new WeakMap<object, PrepareRecipe>();
    _recipesByEngine.set(engine, recipes);
}

/** @internal Register a logical pipeline recipe from a ShaderMaterial renderable builder. */
export function _registerAsyncShaderPipelineRecipe(scene: SceneContext, material: ShaderMaterial, key: Renderable | object, layout: ShaderMaterialPipelineLayout = "mesh"): void {
    _recipesByEngine?.get(scene.surface.engine)?.set(key, { material, layout });
}

/** @internal Run the installed engine's automatic preparation for one scene. */
export function _prepareAsyncShaderPipelinesForScene(scene: SceneContext): Promise<void> {
    const recipes = _recipesByEngine?.get(scene.surface.engine);
    return recipes ? prepareScene(scene.surface.engine, scene, recipes) : Promise.resolve();
}

async function prepareScene(engine: EngineContext, scene: SceneContext, recipes: WeakMap<object, PrepareRecipe>): Promise<void> {
    const tasks: unknown[] = [...scene._frameGraph._tasks];
    if (scene._frameGraph._tasks.some((task) => task.name === "shadow")) {
        for (const light of scene.lights) {
            const generator = light.shadowGenerator;
            const casterMeshes = generator ? _getShadowTaskCasterMeshes(generator) : undefined;
            if (generator?._ensureShadowTaskState && casterMeshes && !generator._preloadPending) {
                tasks.push(generator._ensureShadowTaskState(engine, scene, casterMeshes));
            }
        }
    }

    const seen = new Set<unknown>();
    const preparations: Promise<void>[] = [];
    while (tasks.length) {
        const candidate = tasks.pop();
        if (!candidate || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        tasks.push(...nestedTasks(candidate));
        if (!isRenderTask(candidate)) {
            continue;
        }
        _resolvePendingMeshes(candidate, candidate.scene);
        const renderables = candidate._renderables.length || candidate._config.autoMirror === false ? candidate._renderables : candidate.scene._renderables;
        for (const renderable of renderables) {
            const recipe = recipes.get(renderable) ?? (renderable.mesh && candidate.scene._renderables.includes(renderable) ? recipes.get(renderable.mesh) : undefined);
            if (recipe) {
                const bindings = currentBindings(engine, recipe.material);
                const resolvedLayout = resolveLayout(recipe.material, bindings, recipe.layout);
                preparations.push(
                    prepareShaderPipeline(
                        engine,
                        candidate._targetSignature,
                        recipe.material,
                        bindings,
                        resolvedLayout.variantKey,
                        resolvedLayout.vertexBuffers,
                        resolvedLayout.instanceAttrs
                    )
                );
            }
        }
    }
    const failures = new Set<unknown>();
    for (const result of await Promise.allSettled(preparations)) {
        if (result.status === "rejected") {
            failures.add(result.reason);
        }
    }
    for (const failure of failures) {
        console.error("Async ShaderMaterial pipeline preparation failed; the synchronous first-bind fallback remains available.", failure);
    }
}

/** Prepare one ShaderMaterial pipeline for a known Lite target before its first draw. */
export async function prepareShaderMaterialPipeline(
    engine: EngineContext,
    material: ShaderMaterial,
    layout: ShaderMaterialPipelineLayout,
    target: RenderTarget | RenderTask
): Promise<void> {
    const signature = isRenderTask(target) ? target._targetSignature : renderTargetSignature(target);
    const bindings = currentBindings(engine, material);
    const resolvedLayout = resolveLayout(material, bindings, layout);
    await prepareShaderPipeline(engine, signature, material, bindings, resolvedLayout.variantKey, resolvedLayout.vertexBuffers, resolvedLayout.instanceAttrs);
}

/** Prepare one ShaderMaterial pipeline for a RenderTask using the task's exact attachment signature. */
export function prepareShaderMaterialPipelineForTask(task: RenderTask, material: ShaderMaterial, layout: ShaderMaterialPipelineLayout): Promise<void> {
    return prepareShaderMaterialPipeline(task.engine, material, layout, task);
}

function currentBindings(engine: EngineContext, material: ShaderMaterial): ShaderPipelineBindings {
    retargetShaderPipelineCache(material, engine._device);
    return getOrCreateShaderPipelineBindings(engine, material);
}

async function prepareShaderPipeline(
    engine: EngineContext,
    signature: RenderTargetSignature,
    material: ShaderMaterial,
    bindings: ShaderPipelineBindings,
    variantKey: string,
    vertexBuffers: readonly GPUVertexBufferLayout[],
    instanceAttrs: string
): Promise<void> {
    const simpleKey = `${targetSignatureKey(signature)}${_resolveShaderPipelineVariantKey(signature, material, variantKey)}`;
    if (bindings.pipelines.has(simpleKey)) {
        return;
    }
    const simplePending = bindings._P?.get(simpleKey);
    if (simplePending) {
        await simplePending;
        return;
    }

    const device = engine._device;
    const placeholder = {} as GPURenderPipeline;
    let descriptor: GPURenderPipelineDescriptor | undefined;
    const captureDevice = {
        createShaderModule(moduleDescriptor: GPUShaderModuleDescriptor): GPUShaderModule {
            return device.createShaderModule(moduleDescriptor);
        },
        createRenderPipeline(pipelineDescriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
            descriptor = pipelineDescriptor;
            return placeholder;
        },
    } as GPUDevice;
    const captured = getOrCreateShaderPipeline({ _device: captureDevice } as EngineContext, signature, material, bindings, variantKey, vertexBuffers, instanceAttrs);
    if (captured !== placeholder) {
        return;
    }

    let key: string | undefined;
    for (const [candidate, pipeline] of bindings.pipelines) {
        if (pipeline === placeholder) {
            key = candidate;
            bindings.pipelines.delete(candidate);
            break;
        }
    }
    if (!key || !descriptor) {
        throw new Error("Async ShaderMaterial pipeline preparation could not capture the synchronous descriptor.");
    }

    const pending = bindings._P?.get(key);
    if (pending) {
        await pending;
        return;
    }
    const pendingPipelines = bindings._P ?? (bindings._P = new Map());
    const creation = device.createRenderPipelineAsync(descriptor).then((pipeline) => {
        const winner = bindings.pipelines.get(key);
        if (winner) {
            return winner;
        }
        bindings.pipelines.set(key, pipeline);
        return pipeline;
    });
    pendingPipelines.set(key, creation);
    try {
        await creation;
    } finally {
        if (pendingPipelines.get(key) === creation) {
            pendingPipelines.delete(key);
        }
    }
}

function resolveLayout(
    material: ShaderMaterial,
    bindings: ShaderPipelineBindings,
    layout: ShaderMaterialPipelineLayout
): { readonly variantKey: string; readonly vertexBuffers: readonly GPUVertexBufferLayout[]; readonly instanceAttrs: string } {
    if (layout === "mesh") {
        return { variantKey: "", vertexBuffers: bindings.vertexBuffers, instanceAttrs: "" };
    }
    const hasColor = layout === "thin-instances-color";
    const baseLocation = material.attributes.length;
    const instanceLayouts: GPUVertexBufferLayout[] = [
        {
            arrayStride: 64,
            stepMode: "instance",
            attributes: [
                { shaderLocation: baseLocation, offset: 0, format: "float32x4" },
                { shaderLocation: baseLocation + 1, offset: 16, format: "float32x4" },
                { shaderLocation: baseLocation + 2, offset: 32, format: "float32x4" },
                { shaderLocation: baseLocation + 3, offset: 48, format: "float32x4" },
            ],
        },
    ];
    let instanceAttrs = `@location(${baseLocation}) world0: vec4<f32>,
@location(${baseLocation + 1}) world1: vec4<f32>,
@location(${baseLocation + 2}) world2: vec4<f32>,
@location(${baseLocation + 3}) world3: vec4<f32>,
`;
    if (hasColor) {
        instanceLayouts.push({
            arrayStride: 16,
            stepMode: "instance",
            attributes: [{ shaderLocation: baseLocation + 4, offset: 0, format: "float32x4" }],
        });
        instanceAttrs += `@location(${baseLocation + 4}) instanceColor: vec4<f32>,
`;
    }
    return { variantKey: "" + +hasColor, vertexBuffers: [...bindings.vertexBuffers, ...instanceLayouts], instanceAttrs };
}

function renderTargetSignature(target: RenderTarget): RenderTargetSignature {
    const descriptor = target._descriptor;
    return {
        _colorFormat: descriptor.format,
        _depthStencilFormat: descriptor.dFormat,
        _depthCompare: descriptor._depthCompare,
        _sampleCount: descriptor.samples,
    };
}
