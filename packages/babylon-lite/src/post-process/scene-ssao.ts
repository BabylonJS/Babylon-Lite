import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import { isRenderingContextRegistered } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { addTaskAfter, removeTask } from "../frame-graph/frame-graph-actions.js";
import { buildFrameGraphTask, getFrameGraphTasks } from "../frame-graph/frame-graph.js";
import { createDepthResolveTask } from "../frame-graph/depth-resolve-task.js";
import type { RenderTask } from "../frame-graph/render-task.js";
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
    _baseRt: RenderTarget | null;
    _baseRst: RenderTarget | undefined;
    _priorOutputTexture: RenderTarget | undefined;
    _tasks: Task[];
    _ownedTargets: RenderTarget[];
    _depthResolveTask: Task | null;
    _aoTask: ScreenSpaceAmbientOcclusionPostProcessTask | null;
    _gate: (() => void) | null;
    _sceneDispose: (() => void) | null;
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
        _baseRt: null,
        _baseRst: undefined,
        _priorOutputTexture: undefined,
        _tasks: [],
        _ownedTargets: [],
        _depthResolveTask: null,
        _aoTask: null,
        _gate: null,
        _sceneDispose: null,
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
    owningScene._sceneSsaoPipeline = pipeline;
    try {
        createTasks(pipeline, state);
        state.scene._outputPipelineChange = (ready) => {
            if (ready) {
                state._defaultTask = findDefaultTask(state.scene);
                createTasks(pipeline, state);
                updateExecutionGate(pipeline, state);
            } else {
                cleanupTasks(state);
            }
        };
        state._gate = () => updateExecutionGate(pipeline, state);
        state.scene._beforeRender.push(state._gate);
        registerSceneDisposal(pipeline, state);
        setAttached(pipeline, true);
        updateExecutionGate(pipeline, state);
    } catch (error) {
        unregisterSceneDisposal(state);
        delete state.scene._outputPipelineChange;
        cleanupTasks(state);
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
    unregisterSceneDisposal(state);
    delete state.scene._outputPipelineChange;
    removeGate(state);
    cleanupTasks(state);
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
    const tasks = getFrameGraphTasks(scene._frameGraph);
    const transmissionIndex = tasks.findIndex((task) => task.name === "transmission-image-processing");
    let task: Task | undefined;
    if (transmissionIndex !== -1) {
        for (let i = transmissionIndex - 1; i >= 0; i--) {
            if ("_renderables" in tasks[i]!) {
                task = tasks[i];
                break;
            }
        }
    } else {
        task = tasks.find((candidate) => {
            const renderTask = candidate as Partial<RenderTask>;
            return !!renderTask._config && "_renderables" in candidate && (renderTask._config.rt === scene.surface.scRT || renderTask._config.rst === scene.surface.scRT);
        });
    }
    if (!task) {
        throw new Error("SceneSsaoPipeline requires a scene with a default swapchain render task.");
    }
    return task as RenderTask;
}

function createTasks(pipeline: SceneSsaoPipeline, state: SceneSsaoPipelineState): void {
    const scene = state.scene;
    const engine = state.engine;
    const surface = scene.surface;
    const render = state._defaultTask!;
    const config = render._config;
    const baseRt = config.rt;
    const multisampled = (baseRt._descriptor.samples ?? 1) > 1;
    const transmission = getFrameGraphTasks(scene._frameGraph).some((task) => task.name === "transmission-image-processing");
    state._baseRt = baseRt;
    state._baseRst = config.rst;
    state._priorOutputTexture = scene._outputTexture;
    const source = createRenderTarget({
        lbl: `${pipeline.name}-source`,
        format: baseRt._descriptor.format ?? surface.format,
        samples: 1,
        size: surface,
    });
    state._ownedTargets.push(source);
    if (multisampled) {
        config.rst = source;
    } else {
        config.rt = source;
    }

    let depth = config.depth ?? baseRt;
    if (multisampled) {
        depth = createRenderTarget({ lbl: `${pipeline.name}-depth`, dFormat: "depth24plus-stencil8", samples: 1, size: surface });
        state._ownedTargets.push(depth);
        state._depthResolveTask = createDepthResolveTask({ name: `${pipeline.name}-depth-resolve`, sourceTexture: baseRt, targetTexture: depth }, engine, scene);
        state._tasks.push(state._depthResolveTask);
    }

    const output =
        transmission || multisampled
            ? createRenderTarget({
                  lbl: `${pipeline.name}-output${multisampled && !transmission ? "-msaa" : ""}`,
                  format: baseRt._descriptor.format ?? surface.format,
                  samples: multisampled && !transmission ? surface.msaaSamples : 1,
                  size: surface,
              })
            : surface.scRT;
    if (output !== surface.scRT) {
        state._ownedTargets.push(output);
    }
    if (transmission) {
        scene._outputTexture = output;
    }
    const ao = createScreenSpaceAmbientOcclusionPostProcessTask(
        {
            name: pipeline.name,
            sourceTexture: source,
            depthTexture: depth,
            targetTexture: output,
            resolveTexture: multisampled && !transmission ? surface.scRT : null,
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

    let anchor: Task = render;
    for (const task of state._tasks) {
        addTaskAfter(scene, task, anchor);
        anchor = task;
    }
    if (isRenderingContextRegistered(surface, scene)) {
        buildFrameGraphTask(scene._frameGraph, render);
        for (const task of state._tasks) {
            buildFrameGraphTask(scene._frameGraph, task);
        }
        rebuildTransmissionImageProcessing(state);
    }
}

function updateExecutionGate(pipeline: SceneSsaoPipeline, state: SceneSsaoPipelineState): void {
    const active = pipeline.attached && state.scene.camera === pipeline.camera;
    for (const task of state._tasks) {
        task.executionEnabled = true;
    }
    if (state._depthResolveTask) {
        state._depthResolveTask.executionEnabled = active;
    }
    if (state._aoTask) {
        state._aoTask.enabled = active;
        const resolutionScaleChanged = state._aoTask.resolutionScale !== pipeline.resolutionScale;
        state._aoTask.camera = pipeline.camera;
        state._aoTask.resolutionScale = pipeline.resolutionScale;
        state._aoTask.radius = pipeline.radius;
        state._aoTask.intensity = pipeline.intensity;
        state._aoTask.base = pipeline.base;
        state._aoTask.fadeStart = pipeline.fadeEnd * 0.75;
        state._aoTask.fadeEnd = pipeline.fadeEnd;
        if (resolutionScaleChanged && isRenderingContextRegistered(state.scene.surface, state.scene)) {
            buildFrameGraphTask(state.scene._frameGraph, state._aoTask);
        }
    }
}

function registerSceneDisposal(pipeline: SceneSsaoPipeline, state: SceneSsaoPipelineState): void {
    const dispose = (): void => {
        setAttached(pipeline, false);
        delete state.scene._outputPipelineChange;
        removeGate(state);
        state._tasks.length = 0;
        state._depthResolveTask = null;
        state._aoTask = null;
        const displacedBaseRt = state._defaultTask?._ownsTargets ? state._baseRt : null;
        restoreDefaultTask(state);
        disposeOwnedTargets(state);
        disposeRenderTarget(displacedBaseRt);
        const owningScene = state.scene as SceneWithSsao;
        if (owningScene._sceneSsaoPipeline === pipeline) {
            delete owningScene._sceneSsaoPipeline;
        }
        state._sceneDispose = null;
        state._disposed = true;
    };
    state._sceneDispose = dispose;
    state.scene._disposables.push(dispose);
}

function unregisterSceneDisposal(state: SceneSsaoPipelineState): void {
    if (!state._sceneDispose) {
        return;
    }
    const index = state.scene._disposables.indexOf(state._sceneDispose);
    if (index !== -1) {
        state.scene._disposables.splice(index, 1);
    }
    state._sceneDispose = null;
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
    state._depthResolveTask = null;
    state._aoTask = null;
    restoreDefaultTask(state);
    disposeOwnedTargets(state);
}

function disposeOwnedTargets(state: SceneSsaoPipelineState): void {
    for (const target of state._ownedTargets.splice(0)) {
        disposeRenderTarget(target);
    }
}

function restoreDefaultTask(state: SceneSsaoPipelineState): void {
    if (state._defaultTask && state._baseRt) {
        state._defaultTask._config.rt = state._baseRt;
        state._defaultTask._config.rst = state._baseRst;
    }
    state.scene._outputTexture = state._priorOutputTexture;
    if (state._defaultTask && isRenderingContextRegistered(state.scene.surface, state.scene)) {
        buildFrameGraphTask(state.scene._frameGraph, state._defaultTask);
    }
    rebuildTransmissionImageProcessing(state);
    state._baseRt = null;
    state._baseRst = undefined;
    state._priorOutputTexture = undefined;
}

function rebuildTransmissionImageProcessing(state: SceneSsaoPipelineState): void {
    if (!isRenderingContextRegistered(state.scene.surface, state.scene)) {
        return;
    }
    const task = getFrameGraphTasks(state.scene._frameGraph).find((candidate) => candidate.name === "transmission-image-processing");
    if (task) {
        buildFrameGraphTask(state.scene._frameGraph, task);
    }
}
