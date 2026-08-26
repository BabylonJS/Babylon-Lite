import {
    createGLEngine,
    disposeGLEngine,
    disposeTexture,
    getRenderHeight,
    getRenderingCanvas,
    getRenderWidth,
    setGLEngineSize,
    setViewport,
    type GLEngineContext,
} from "babylon-lite-gl";

import { type RawLottieAnimation } from "../parsing/rawTypes";
import { type AnimationInfo } from "../parsing/parsedTypes";
import { ResetNode, UpdateNode, type AnimationNode } from "../nodes/node";
import { type LottieFeatureSet } from "../features/feature";
import {
    type AnimationConfiguration,
    type LottieFeatureConfig,
    type LottieRendererConfig,
    ResolveFeatureConfiguration,
    ResolveRendererConfiguration,
} from "../animationConfiguration";

import { type RenderingManager, createRenderingManager, disposeRenderingManager, renderFrame } from "./renderingManager";
import { type Matrix, createMatrix, setMatrixIdentity, setMatrixOrtho } from "../maths/matrix";
import { type SpritePacker, createSpritePacker, getSpritePackerTextures } from "../parsing/spritePacker";
import { LoadLottieFeatures } from "../load/loadFeatures";
import { ParseAnimation, ParseAnimationAsync } from "../load/parseAnimation";

type AnimationControllerOptions = {
    loadedFeatures?: LottieFeatureSet;
    skipInitialParse?: boolean;
};

/**
 * Plain-data state that controls the playing of a lottie animation. This is operated on by the
 * functions below — there is no instance behavior.
 */
export type AnimationController = {
    /** Whether the controller has finished parsing and is ready to play. */
    isReady: boolean;
    /** The canvas the animation renders into. */
    canvas: HTMLCanvasElement | OffscreenCanvas;
    /** The scale factor for the canvas / viewport (may be < 1 when the animation is larger than the container). */
    canvasScale: number;
    /** The scale factor for the sprite atlas (always >= 1 to keep sprites crisp). */
    atlasScale: number;
    /** Map of variables to replace in the animation file. */
    variables: Map<string, string>;
    /** Resolved engine-free feature configuration. */
    featureConfiguration: LottieFeatureConfig;
    /** Resolved renderer-bound configuration. */
    rendererConfiguration: LottieRendererConfig;
    /** lite-gl engine context used for rendering. */
    engine: GLEngineContext;
    /** Sprite atlas packer. */
    spritePacker: SpritePacker;
    /** Rendering manager that batches and draws the sprites. */
    renderingManager: RenderingManager;
    /** Parsed animation info (node graph and timing), or undefined before parsing. */
    animation: AnimationInfo | undefined;
    /** Orthographic projection matrix uploaded to the GPU. */
    projectionMatrix: Matrix;
    /** Identity (Y-flipped) view matrix uploaded to the GPU. */
    worldMatrix: Matrix;
    /** Whether the next render-loop tick is the first one (used to sync timing). */
    firstRun: boolean;
    /** Duration of a single animation frame in milliseconds. */
    frameDuration: number;
    /** The current animation frame. */
    currentFrame: number;
    /** Whether the animation is currently playing. */
    isPlaying: boolean;
    /** Handle of the pending requestAnimationFrame, or null when not scheduled. */
    animationFrameId: number | null;
    /** Timestamp of the previous render-loop tick. */
    lastFrameTime: number;
    /** Elapsed time since the previous tick, in milliseconds. */
    deltaTime: number;
    /** Whether the animation should loop. */
    loop: boolean;
    /** Whether at least one frame has been rendered. */
    hasRendered: boolean;
    /** Accumulated time used to decide how many frames to advance. */
    accumulatedTime: number;
    /** Number of frames to advance this tick. */
    framesToAdvance: number;
    /** Optional callback invoked after the first frame renders. */
    onFirstRender?: () => void;
};

/**
 * Creates and initializes a new animation controller using runtime feature detection and loading.
 * @param canvas The canvas element to render the animation on.
 * @param animationData The raw lottie animation as a JSON object.
 * @param canvasScale The scale factor for the canvas / viewport (may be \< 1 when the animation is larger than the container).
 * @param atlasScale The scale factor for the sprite atlas (always \>= 1 to keep sprites crisp).
 * @param variables Map of variables to replace in the animation file.
 * @param configuration The partial configuration for the animation player. Will be finalized after engine creation.
 * @param mainThreadDevicePixelRatio The devicePixelRatio from the main thread (used in worker scenarios).
 * @param onFirstRender Optional callback invoked after the first frame renders.
 * @returns Initialized animation controller.
 */
export async function createAnimationControllerAsync(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    animationData: RawLottieAnimation,
    canvasScale: number,
    atlasScale: number,
    variables: Map<string, string>,
    configuration: Partial<AnimationConfiguration>,
    mainThreadDevicePixelRatio?: number,
    onFirstRender?: () => void
): Promise<AnimationController> {
    const controller = createAnimationController(canvas, animationData, canvasScale, atlasScale, variables, configuration, mainThreadDevicePixelRatio, onFirstRender, {
        skipInitialParse: true,
    });

    try {
        const loadedFeatures = await LoadLottieFeatures(animationData, controller.featureConfiguration);
        const animationInfo = await ParseAnimationAsync(animationData, loadedFeatures, controller.featureConfiguration, controller.rendererConfiguration, {
            packer: controller.spritePacker,
            renderingManager: controller.renderingManager,
        });
        ApplyAnimationInfo(controller, animationData, animationInfo);
    } catch (error: unknown) {
        disposeAnimationController(controller);
        throw error;
    }

    return controller;
}

/**
 * Creates a new animation controller, optionally parsing the animation synchronously.
 * @param canvas The canvas element to render the animation on.
 * @param animationData The raw lottie animation as a JSON object.
 * @param canvasScale The scale factor for the canvas / viewport (may be \< 1 when the animation is larger than the container).
 * @param atlasScale The scale factor for the sprite atlas (always \>= 1 to keep sprites crisp).
 * @param variables Map of variables to replace in the animation file.
 * @param configuration The partial configuration for the animation player. Will be finalized after engine creation.
 * @param mainThreadDevicePixelRatio The devicePixelRatio from the main thread (used in worker scenarios).
 * @param onFirstRender Optional callback invoked after the first frame renders.
 * @param options Optional parser-control options used by async feature-loading paths.
 * @returns The new animation controller.
 */
export function createAnimationController(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    animationData: RawLottieAnimation,
    canvasScale: number,
    atlasScale: number,
    variables: Map<string, string>,
    configuration: Partial<AnimationConfiguration>,
    mainThreadDevicePixelRatio?: number,
    onFirstRender?: () => void,
    options?: AnimationControllerOptions
): AnimationController {
    const featureConfiguration = ResolveFeatureConfiguration(configuration);

    const engine = createGLEngine(canvas, {
        alpha: true,
        stencil: false,
        antialias: false,
        depth: false,
        // Important to allow skip frame and tiled optimizations
        preserveDrawingBuffer: false,
        premultipliedAlpha: true, // Premultiplied alpha avoids colors bleeding in the texture atlas
    });

    // Finalize configuration now that we can query GPU capabilities
    const maxTextureSize = engine.caps.maxTextureSize;
    const rendererConfiguration = ResolveRendererConfiguration(configuration, maxTextureSize, mainThreadDevicePixelRatio);

    // lite-gl owns context-restore, depth/stencil disabling (the context is created with depth:false),
    // parallel-compile handling, and per-draw blend (the sprite renderer applies its own alpha mode),
    // so the old ThinEngine caps/depth/stencil/alpha boot tweaks are not needed here.
    const controller: AnimationController = {
        isReady: false,
        canvas,
        canvasScale,
        atlasScale,
        variables,
        featureConfiguration,
        rendererConfiguration,
        engine,
        spritePacker: createSpritePacker(engine, IsHtmlCanvas(canvas), atlasScale, variables, rendererConfiguration),
        renderingManager: createRenderingManager(engine, rendererConfiguration),
        animation: undefined,
        projectionMatrix: createMatrix(),
        worldMatrix: createMatrix(),
        firstRun: true,
        frameDuration: 1000 / 30, // Default to 30 FPS
        currentFrame: 0,
        isPlaying: false,
        animationFrameId: null,
        lastFrameTime: 0,
        deltaTime: 0,
        loop: featureConfiguration.loopAnimation,
        hasRendered: false,
        accumulatedTime: 0,
        framesToAdvance: 0,
        onFirstRender,
    };

    setMatrixIdentity(controller.worldMatrix);

    if (!options?.skipInitialParse) {
        const animationInfo = ParseAnimation(animationData, options?.loadedFeatures, featureConfiguration, rendererConfiguration, {
            packer: controller.spritePacker,
            renderingManager: controller.renderingManager,
        });
        ApplyAnimationInfo(controller, animationData, animationInfo);
    }

    return controller;
}

/**
 * Plays the animation.
 * @param controller The animation controller.
 */
export function playAnimation(controller: AnimationController): void {
    if (controller.animation === undefined || !controller.isReady) {
        return;
    }

    controller.currentFrame = 0;
    controller.accumulatedTime = 0;
    controller.framesToAdvance = 0;
    controller.isPlaying = true;
    controller.lastFrameTime = 0;

    // Start the render loop
    StartRenderLoop(controller);
}

/**
 * Stops the animation playback.
 * @param controller The animation controller.
 */
export function stopAnimation(controller: AnimationController): void {
    controller.accumulatedTime = 0;
    controller.framesToAdvance = 0;
    controller.isPlaying = false;
    if (controller.animationFrameId !== null) {
        cancelAnimationFrame(controller.animationFrameId);
        controller.animationFrameId = null;
    }
}

/**
 * Sets a new canvas scale factor for the animation and updates the rendering size.
 * This only affects the canvas/viewport size, not the sprite atlas.
 * @param controller The animation controller.
 * @param canvasScale The new canvas scale factor to apply to the animation.
 */
export function setControllerScale(controller: AnimationController, canvasScale: number): void {
    if (canvasScale <= 0 || controller.animation === undefined) {
        return;
    }

    controller.canvasScale = canvasScale;
    SetSize(controller, controller.animation.widthPx, controller.animation.heightPx, controller.canvasScale);
}

/**
 * Disposes the controller and releases all resources.
 * @param controller The animation controller.
 */
export function disposeAnimationController(controller: AnimationController): void {
    stopAnimation(controller);

    // Offscreen canvas do not have .remove() as it doesn't inherit from Element
    disposeRenderingManager(controller.renderingManager);
    for (const texture of getSpritePackerTextures(controller.spritePacker)) {
        disposeTexture(controller.engine, texture);
    }

    const canvas = getRenderingCanvas(controller.engine);
    if (canvas && "remove" in canvas) {
        canvas.remove();
    }

    disposeGLEngine(controller.engine);
}

function ApplyAnimationInfo(controller: AnimationController, animationData: RawLottieAnimation, animationInfo: AnimationInfo): void {
    controller.animation = animationInfo;
    controller.frameDuration = 1000 / animationInfo.frameRate;

    CleanTree(animationInfo.nodes);
    SetSize(controller, animationData.w, animationData.h, controller.canvasScale);

    controller.isReady = true;
}

/**
 * Sets the rendering size for the engine.
 *
 * The engine back-buffer is sized to the canvas (width * canvasScale * dpr),
 * but the orthographic projection maps the coordinate space so that sprites
 * rasterised at `atlasScale` in the atlas are correctly placed in the
 * `canvasScale`-sized viewport.
 *
 * @param controller The animation controller.
 * @param width Width of the rendering canvas
 * @param height Height of the rendering canvas
 * @param canvasScale Canvas scale ratio between the container and the animation
 */
function SetSize(controller: AnimationController, width: number, height: number, canvasScale: number): void {
    const engine = controller.engine;
    const projectionMatrix = controller.projectionMatrix;
    const worldMatrix = controller.worldMatrix;
    const devicePixelRatio = controller.rendererConfiguration.devicePixelRatio;

    setGLEngineSize(engine, width * canvasScale * devicePixelRatio, height * canvasScale * devicePixelRatio);

    worldMatrix[5] = -1; // we are upside down with Lottie

    // The projection always maps the full animation coordinate space [0, width] × [0, height]
    // into the canvas. Dividing by canvasScale cancels it out from
    // the engine resolution, so sprites positioned in animation-space render correctly
    // regardless of whether the canvas is smaller or larger than the animation.
    setMatrixOrtho(projectionMatrix, 0, getRenderWidth(engine) / (devicePixelRatio * canvasScale), getRenderHeight(engine) / (devicePixelRatio * canvasScale), 0, -100, 100);

    // If we are not playing anymore (animation finished), resizing clears the buffer.
    // Redraw the last frame so the canvas does not appear blank after a resize.
    if (!controller.isPlaying && controller.animation) {
        setViewport(engine);
        renderFrame(controller.renderingManager, worldMatrix, projectionMatrix);
    }
}

function IsHtmlCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
    return typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement;
}

function CleanTree(nodes: AnimationNode[]): void {
    // Remove non shape nodes
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.children.length === 0 && !node.isShape) {
            nodes.splice(i, 1);
            i--;
            continue;
        }

        CleanTree(node.children);
    }
}

function StartRenderLoop(controller: AnimationController): void {
    if (!controller.isPlaying) {
        return;
    }

    controller.animationFrameId = requestAnimationFrame((currentTime) => {
        // The first time we render, we set the last frame time
        // to the current time to sync with the page startup time
        if (controller.firstRun) {
            controller.lastFrameTime = currentTime;
            controller.firstRun = false;
        }

        controller.deltaTime = currentTime - controller.lastFrameTime;
        controller.lastFrameTime = currentTime;

        Render(controller);
        controller.lastFrameTime = performance.now();

        // Continue the loop if still playing
        if (controller.isPlaying) {
            StartRenderLoop(controller);
        }
    });
}

function Render(controller: AnimationController): void {
    if (!controller.animation || !controller.isPlaying) {
        return;
    }

    setViewport(controller.engine);

    // Calculate the new frame based on time
    controller.accumulatedTime += controller.deltaTime;
    controller.framesToAdvance = Math.floor(controller.accumulatedTime / controller.frameDuration);

    if (controller.framesToAdvance <= 0) {
        return;
    }

    controller.accumulatedTime -= controller.framesToAdvance * controller.frameDuration;

    controller.currentFrame += controller.framesToAdvance;

    if (controller.currentFrame < controller.animation.startFrame) {
        return;
    }

    let stoppingAfterThisFrame = false;
    const effectiveEndFrame =
        controller.featureConfiguration.stopAtFrame !== undefined
            ? Math.min(controller.featureConfiguration.stopAtFrame, controller.animation.endFrame)
            : controller.animation.endFrame;
    // Lottie out-point (op) is exclusive — the last visible frame is op - 1
    const lastVisibleFrame = controller.featureConfiguration.stopAtFrame !== undefined ? effectiveEndFrame : effectiveEndFrame - 1;

    if (controller.currentFrame > lastVisibleFrame) {
        if (controller.loop && controller.featureConfiguration.stopAtFrame === undefined) {
            controller.currentFrame = (controller.currentFrame % (controller.animation.endFrame - controller.animation.startFrame)) + controller.animation.startFrame;
            for (let i = 0; i < controller.animation.nodes.length; i++) {
                ResetNode(controller.animation.nodes[i]);
            }
        } else {
            // When not looping, clamp to the last visible frame
            controller.currentFrame = lastVisibleFrame;
            stoppingAfterThisFrame = true;
        }
    }

    for (let i = 0; i < controller.animation.nodes.length; i++) {
        UpdateNode(controller.animation.nodes[i], controller.currentFrame);
    }

    // Render all layers of the animation
    renderFrame(controller.renderingManager, controller.worldMatrix, controller.projectionMatrix);

    if (!controller.hasRendered) {
        controller.hasRendered = true;
        controller.onFirstRender?.();
    }

    if (stoppingAfterThisFrame) {
        if (controller.featureConfiguration.stopAtFrame === undefined) {
            controller.isPlaying = false;
        }
        // When stopAtFrame is set, the render loop stays alive to prevent
        // preserveDrawingBuffer:false from clearing the canvas.
    }
}
