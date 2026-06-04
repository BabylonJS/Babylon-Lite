import { registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { EngineContext, RenderingContext } from "../engine/engine.js";
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
    readonly engine: EngineContext;
    readonly frameGraph: FrameGraph;
    clearColor: GPUColorDict;
}

interface FrameGraphContextInternal extends FrameGraphContext {
    readonly _engine: EngineContext;
    _disposed: boolean;
}

/** Create a scene-less frame-graph context for fullscreen effects and post-process chains. */
export function createFrameGraphContext(engine: EngineContext, options?: FrameGraphContextOptions): FrameGraphContext {
    const eng = engine as EngineContext;
    const update = options?.update;
    const ctx: FrameGraphContextInternal = {
        name: options?.name ?? "frame-graph",
        engine,
        _engine: eng,
        frameGraph: createFrameGraph(eng),
        clearColor: options?.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _disposed: false,
        _update(): void {
            if (ctx._disposed) {
                return;
            }
            update?.(eng._currentDelta);
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

/** Build and register the standalone frame-graph context with its engine. */
export function registerFrameGraphContext(ctx: FrameGraphContext): void {
    const internal = ctx as FrameGraphContextInternal;
    if (internal._disposed) {
        return;
    }
    ctx.frameGraph.build();
    registerRenderingContext(internal._engine, ctx);
}

/** Unregister the standalone frame-graph context from its engine. */
export function unregisterFrameGraphContext(ctx: FrameGraphContext): void {
    const internal = ctx as FrameGraphContextInternal;
    unregisterRenderingContext(internal._engine, ctx);
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
