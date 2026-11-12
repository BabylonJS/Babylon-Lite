import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import { isRenderingContextRegistered } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { addTaskAfter, removeTask } from "../frame-graph/frame-graph-actions.js";
import { buildFrameGraphTask, getFrameGraphTasks } from "../frame-graph/frame-graph.js";
import { createDepthResolveTask } from "../frame-graph/depth-resolve-task.js";
import { createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createScreenSpaceAmbientOcclusionPostProcessTask, type ScreenSpaceAmbientOcclusionPostProcessTask } from "./screen-space-ambient-occlusion.js";

/** Options for a scene-output ambient-occlusion pipeline. */
export interface SceneSsaoPipelineOptions {
    name?: string;
    resolutionScale?: number;
    radius?: number;
    intensity?: number;
    base?: number;
    fadeEnd?: number;
}

/** Native scene-output ambient-occlusion controller used by API adapters. */
export interface SceneSsaoPipeline {
    readonly name: string;
    camera: Camera;
    resolutionScale: number;
    radius: number;
    intensity: number;
    base: number;
    fadeEnd: number;
    readonly attached: boolean;
}

interface SceneSsaoPipelineState {
    engine: EngineContext;
    scene: SceneContext;
    _disposed: boolean;
    _defaultTask: RenderTask | null;
    _defaultExecutionEnabled: boolean | undefined;
    _tasks: Task[];
    _ownedTargets: RenderTarget[];
    _aoTask: ScreenSpaceAmbientOcclusionPostProcessTask | null;
    _gate: (() => void) | null;
}

interface SceneWithSsao extends SceneContext {
    _sceneSsaoPipeline?: SceneSsaoPipeline;
}

let _pipelineStates: WeakMap<SceneSsaoPipeline, SceneSsaoPipelineState> | null = null;

function pipelineState(pipeline: SceneSsaoPipeline): SceneSsaoPipelineState {
    const state = _pipelineStates?.get(pipeline);
    if (!state) {
        throw new Error("SceneSsaoPipeline is not a live pipeline created by createSceneSsaoPipeline().");
    }
    return state;
}

/** Create an initially detached native scene-output SSAO pipeline. */
export function createSceneSsaoPipeline(options: SceneSsaoPipelineOptions, engine: EngineContext, scene: SceneContext, camera: Camera): SceneSsaoPipeline {
    const pipeline: SceneSsaoPipeline = {
        name: options.name ?? "scene-ssao",
        camera,
        resolutionScale: options.resolutionScale ?? 0.5,
        radius: options.radius ?? 0.5,
        intensity: options.intensity ?? 1,
        base: options.base ?? 0,
        fadeEnd: options.fadeEnd ?? 60,
        attached: false,
    };
    const state: SceneSsaoPipelineState = {
        engine,
        scene,
        _disposed: false,
        _defaultTask: null,
        _defaultExecutionEnabled: undefined,
        _tasks: [],
        _ownedTargets: [],
        _aoTask: null,
        _gate: null,
    };
    (_pipelineStates ??= new WeakMap()).set(pipeline, state);
    return pipeline;
}

/** Attach a native scene-output SSAO pipeline to one fullscreen camera. */
export function attachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera = pipeline.camera): void {
    const state = pipelineState(pipeline);
    if (state._disposed) {
        throw new Error(`SceneSsaoPipeline "${pipeline.name}" has been disposed.`);
    }
    if (pipeline.attached) {
        if (pipeline.camera !== camera) {
            throw new Error(`SceneSsaoPipeline "${pipeline.name}" is already attached to another camera.`);
        }
        return;
    }
    const owningScene = state.scene as SceneWithSsao;
    if (owningScene._sceneSsaoPipeline && owningScene._sceneSsaoPipeline !== pipeline) {
        throw new Error("Only one scene SSAO pipeline can be attached at a time.");
    }
    pipeline.camera = camera;
    const defaultTask = findDefaultTask(state.scene);
    state._defaultTask = defaultTask;
    state._defaultExecutionEnabled = defaultTask.executionEnabled;
    owningScene._sceneSsaoPipeline = pipeline;
    try {
        createTasks(pipeline, state);
        state._gate = () => updateExecutionGate(pipeline, state);
        state.scene._beforeRender.unshift(state._gate);
        setAttached(pipeline, true);
        updateExecutionGate(pipeline, state);
    } catch (error) {
        cleanupTasks(state);
        restoreDefaultTask(state);
        delete owningScene._sceneSsaoPipeline;
        throw error;
    }
}

/** Detach and release the owned graph chain while preserving the pipeline settings. */
export function detachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera = pipeline.camera): void {
    const state = pipelineState(pipeline);
    if (!pipeline.attached || camera !== pipeline.camera) {
        return;
    }
    setAttached(pipeline, false);
    removeGate(state);
    cleanupTasks(state);
    restoreDefaultTask(state);
    const owningScene = state.scene as SceneWithSsao;
    if (owningScene._sceneSsaoPipeline === pipeline) {
        delete owningScene._sceneSsaoPipeline;
    }
}

/** Permanently dispose a native scene-output SSAO pipeline. */
export function disposeSceneSsaoPipeline(pipeline: SceneSsaoPipeline): void {
    const state = pipelineState(pipeline);
    if (state._disposed) {
        return;
    }
    detachSceneSsaoPipeline(pipeline);
    state._disposed = true;
}

function setAttached(pipeline: SceneSsaoPipeline, attached: boolean): void {
    (pipeline as { attached: boolean }).attached = attached;
}

function findDefaultTask(scene: SceneContext): RenderTask {
    const task = getFrameGraphTasks(scene._frameGraph).find((candidate) => {
        const renderTask = candidate as Partial<RenderTask>;
        return renderTask._config?.rt === scene.surface.scRT || renderTask._config?.rst === scene.surface.scRT;
    });
    if (!task) {
        throw new Error("SceneSsaoPipeline requires a scene with a default swapchain render task.");
    }
    return task as RenderTask;
}

function createTasks(pipeline: SceneSsaoPipeline, state: SceneSsaoPipelineState): void {
    const scene = state.scene;
    const engine = state.engine;
    const surface = scene.surface;
    const multisampled = surface.msaaSamples > 1;
    const source = createRenderTarget({
        lbl: `${pipeline.name}-source`,
        format: surface.format,
        dFormat: multisampled ? undefined : "depth24plus-stencil8",
        samples: 1,
        size: surface,
    });
    const renderTarget = multisampled
        ? createRenderTarget({
              lbl: `${pipeline.name}-source-msaa`,
              format: surface.format,
              dFormat: "depth24plus-stencil8",
              samples: surface.msaaSamples,
              size: surface,
          })
        : source;
    const render = createRenderTask({ name: `${pipeline.name}-scene`, rt: renderTarget, rst: multisampled ? source : undefined, clr: true }, engine, scene);
    state._tasks.push(render);

    let depth = source;
    if (multisampled) {
        depth = createRenderTarget({ lbl: `${pipeline.name}-depth`, dFormat: "depth24plus-stencil8", samples: 1, size: surface });
        state._ownedTargets.push(depth);
        state._tasks.push(createDepthResolveTask({ name: `${pipeline.name}-depth-resolve`, sourceTexture: renderTarget, targetTexture: depth }, engine, scene));
    }

    const output = multisampled ? createRenderTarget({ lbl: `${pipeline.name}-output-msaa`, format: surface.format, samples: surface.msaaSamples, size: surface }) : surface.scRT;
    if (multisampled) {
        state._ownedTargets.push(output);
    }
    const ao = createScreenSpaceAmbientOcclusionPostProcessTask(
        {
            name: pipeline.name,
            sourceTexture: source,
            depthTexture: depth,
            targetTexture: output,
            resolveTexture: multisampled ? surface.scRT : null,
            camera: pipeline.camera,
            resolutionScale: pipeline.resolutionScale,
            radius: pipeline.radius,
            intensity: pipeline.intensity,
            base: pipeline.base,
            fadeStart: pipeline.fadeEnd * 0.75,
            fadeEnd: pipeline.fadeEnd,
        },
        engine,
        scene
    );
    state._aoTask = ao;
    state._tasks.push(ao);

    let anchor: Task = state._defaultTask!;
    for (const task of state._tasks) {
        addTaskAfter(scene, task, anchor);
        anchor = task;
    }
    if (isRenderingContextRegistered(surface, scene)) {
        for (const task of state._tasks) {
            buildFrameGraphTask(scene._frameGraph, task);
        }
    }
}

function updateExecutionGate(pipeline: SceneSsaoPipeline, state: SceneSsaoPipelineState): void {
    const active = pipeline.attached && state.scene.camera === pipeline.camera;
    if (state._defaultTask) {
        state._defaultTask.executionEnabled = active ? false : state._defaultExecutionEnabled;
    }
    for (const task of state._tasks) {
        task.executionEnabled = active;
    }
    if (state._aoTask) {
        state._aoTask.camera = pipeline.camera;
        state._aoTask.resolutionScale = pipeline.resolutionScale;
        state._aoTask.radius = pipeline.radius;
        state._aoTask.intensity = pipeline.intensity;
        state._aoTask.base = pipeline.base;
        state._aoTask.fadeStart = pipeline.fadeEnd * 0.75;
        state._aoTask.fadeEnd = pipeline.fadeEnd;
    }
}

function removeGate(state: SceneSsaoPipelineState): void {
    if (!state._gate) {
        return;
    }
    const index = state.scene._beforeRender.indexOf(state._gate);
    if (index !== -1) {
        state.scene._beforeRender.splice(index, 1);
    }
    state._gate = null;
}

function cleanupTasks(state: SceneSsaoPipelineState): void {
    for (let i = state._tasks.length - 1; i >= 0; i--) {
        const task = state._tasks[i]!;
        removeTask(state.scene, task);
        task.dispose();
    }
    state._tasks.length = 0;
    state._aoTask = null;
    for (const target of state._ownedTargets.splice(0)) {
        disposeRenderTarget(target);
    }
}

function restoreDefaultTask(state: SceneSsaoPipelineState): void {
    if (state._defaultTask) {
        state._defaultTask.executionEnabled = state._defaultExecutionEnabled;
    }
    state._defaultTask = null;
    state._defaultExecutionEnabled = undefined;
}
