import { registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { RenderingContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import { createFrameGraph } from "./frame-graph.js";
import type { FrameGraph } from "./frame-graph.js";

/** Options for a standalone frame-graph rendering context. */
export interface FrameGraphContextOptions {
    /** Label used for diagnostics and GPU resource naming. */
    name?: string;
    /** Context clear color metadata; individual tasks still control their own render-target clears. */
    clearColor?: GPUColorDict;
    /** Per-frame callback invoked before the frame graph executes; use it to update uniforms or other task inputs. */
    update?: (deltaMs: number) => void;
}

/** A scene-less rendering context driven directly by a FrameGraph. */
export interface FrameGraphContext extends RenderingContext {
    readonly name: string;
    /** Surface this context renders into. */
    readonly surface: SurfaceContext;
    readonly frameGraph: FrameGraph;
    clearColor: GPUColorDict;
}

interface FrameGraphContextInternal extends FrameGraphContext {
    _disposed: boolean;
}

/** Create a scene-less frame-graph context bound to `surface`, for fullscreen effects
 *  and post-process chains. Pass the engine directly for the single-canvas case (since
 *  `EngineContext extends SurfaceContext`); pass an auxiliary surface for multi-canvas. */
export function createFrameGraphContext(surface: SurfaceContext, options?: FrameGraphContextOptions): FrameGraphContext {
    const engine = surface.engine;
    const update = options?.update;
    const ctx: FrameGraphContextInternal = {
        name: options?.name ?? "frame-graph",
        surface,
        frameGraph: createFrameGraph(engine),
        clearColor: options?.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _disposed: false,
        _update(): void {
            if (ctx._disposed) {
                return;
            }
            update?.(engine._currentDelta);
        },
        _record(): number {
            if (ctx._disposed) {
                return 0;
            }
            return ctx.frameGraph.execute();
        },
        _resize(): void {
            if (ctx._disposed) {
                return;
            }
            ctx.frameGraph.build();
        },
    };
    return ctx;
}

/** Build and register the standalone frame-graph context with its surface. */
export function registerFrameGraphContext(ctx: FrameGraphContext): void {
    const internal = ctx as FrameGraphContextInternal;
    if (internal._disposed) {
        return;
    }
    ctx.frameGraph.build();
    registerRenderingContext(ctx.surface, ctx);
}

/** Unregister the standalone frame-graph context from its surface. */
export function unregisterFrameGraphContext(ctx: FrameGraphContext): void {
    unregisterRenderingContext(ctx.surface, ctx);
}

/** Unregister and dispose all GPU resources owned by the standalone frame graph. */
export function disposeFrameGraphContext(ctx: FrameGraphContext): void {
    const internal = ctx as FrameGraphContextInternal;
    if (internal._disposed) {
        return;
    }
    unregisterFrameGraphContext(ctx);
    ctx.frameGraph.dispose();
    internal._disposed = true;
}
