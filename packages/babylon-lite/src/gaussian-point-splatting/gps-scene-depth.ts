import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Camera } from "../camera/camera.js";
import { gpsRenderTask } from "./gps-pass.js";

export function gpsHasViewport(context: DrawUpdateContext | null): context is DrawUpdateContext & { _camera: Camera } {
    const camera = context?._camera;
    if (!camera || !context) {
        return false;
    }
    if (context.targetWidth <= 0 || context.targetHeight <= 0 || (camera.viewport && (camera.viewport.width <= 0 || camera.viewport.height <= 0))) {
        return false;
    }
    const { width, height } = gpsViewport(context);
    return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height);
}

export function gpsViewport(context: DrawUpdateContext): { x: number; y: number; width: number; height: number } {
    const viewport = context._camera?.viewport;
    const x = Math.floor((viewport?.x ?? 0) * context.targetWidth);
    const y = Math.floor((viewport ? 1 - viewport.y - viewport.height : 0) * context.targetHeight);
    const right = Math.ceil((viewport ? viewport.x + viewport.width : 1) * context.targetWidth);
    const bottom = Math.ceil((viewport ? 1 - viewport.y : 1) * context.targetHeight);
    return { x, y, width: right - x, height: bottom - y };
}

export function gpsOpaqueSources(scene: SceneContext, signature: RenderTargetSignature): readonly Renderable[] {
    return gpsRenderTask(scene, signature)?._renderables ?? scene._renderables;
}

/** Borrowed consuming-pass depth. Geometry, coverage and stencil are never replayed. */
export interface GpsSceneDepth {
    texture: GPUTexture | null;
    view: GPUTextureView | null;
    active: boolean;
    signature: RenderTargetSignature | null;
    samples: number;
    x: number;
    y: number;
}

export function gpsCreateSceneDepth(): GpsSceneDepth {
    return { texture: null, view: null, active: false, signature: null, samples: 1, x: 0, y: 0 };
}

export function gpsRecordSceneDepth(
    state: GpsSceneDepth,
    scene: SceneContext,
    _engine: EngineContext,
    signature: RenderTargetSignature,
    context: DrawUpdateContext,
    precedingDraws?: boolean
): boolean {
    state.active = false;
    if (!gpsHasViewport(context)) {
        return false;
    }
    const task = gpsRenderTask(scene, signature);
    const config = task?._config;
    const target = config && (config.depth ?? config.rt);
    const texture = target?._depthTexture ?? null;
    const loaded = config && (config.depth ? target?._eager : config.depthClear === false);
    if (!texture || (!loaded && !(precedingDraws ?? gpsOpaqueSources(scene, signature).some((renderable) => !renderable.isTransparent)))) {
        return false;
    }
    if (state.texture !== texture) {
        state.texture = texture;
        state.view = texture.createView({ aspect: "depth-only" });
    }
    state.active = true;
    state.signature = signature;
    state.samples = signature._sampleCount;
    const viewport = gpsViewport(context);
    state.x = viewport.x;
    state.y = viewport.y;
    return true;
}
