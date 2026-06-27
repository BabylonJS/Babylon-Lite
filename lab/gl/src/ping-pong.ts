import { createRenderTarget, disposeRenderTarget, resizeRenderTarget, type GLEngineContext, type GLRenderTarget, type GLRenderTargetOptions } from "babylon-lite-gl";

/**
 * A pair of same-sized {@link GLRenderTarget}s for self-feedback effects: SAMPLE
 * the {@link GLPingPong.read | read} target (the previous frame's output) while
 * RENDERING into the {@link GLPingPong.write | write} target, then
 * {@link GLPingPong.swap}.
 *
 * This is a lab helper, NOT part of `@babylonjs/lite-gl`: it is trivially composed
 * from the package's public render-target primitives, so it lives next to the
 * demos that use it rather than expanding the package's API surface.
 */
export interface GLPingPong {
    /** The target to SAMPLE this frame (the previous frame's output). */
    readonly read: GLRenderTarget;
    /** The target to RENDER into this frame. */
    readonly write: GLRenderTarget;
    /** Exchange `read` and `write`. Allocation-free (flips an index). Call after
     *  rendering the `write` target each frame. */
    swap(): void;
    /** Resize both targets. No-op once disposed. */
    resize(width: number, height: number): void;
    /** Release both targets. Idempotent. */
    dispose(): void;
}

/**
 * Create a {@link GLPingPong}: two same-sized render targets (`options` applied to
 * both). If the second target fails to build, the first is disposed before
 * rethrowing (no leak).
 */
export function createPingPong(engine: GLEngineContext, options: GLRenderTargetOptions): GLPingPong {
    const a = createRenderTarget(engine, options);
    let b: GLRenderTarget;
    try {
        b = createRenderTarget(engine, options);
    } catch (e) {
        disposeRenderTarget(engine, a);
        throw e;
    }

    let readIsA = true;
    let disposed = false;

    return {
        get read(): GLRenderTarget {
            return readIsA ? a : b;
        },
        get write(): GLRenderTarget {
            return readIsA ? b : a;
        },
        swap(): void {
            readIsA = !readIsA;
        },
        resize(width: number, height: number): void {
            if (disposed) {
                return;
            }
            resizeRenderTarget(engine, a, width, height);
            resizeRenderTarget(engine, b, width, height);
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeRenderTarget(engine, a);
            disposeRenderTarget(engine, b);
        },
    };
}
