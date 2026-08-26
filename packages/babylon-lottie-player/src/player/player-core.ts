// Player core — the renderer-agnostic spine shared by the full player (root entry) and the
// minimal shapes-only player (`/shapes` entry). It owns engine creation, the per-frame render
// loop, readiness and disposal, and the parent-transform resolution — none of which reference any
// specific renderer. The two player factories differ ONLY in which LayerRenderers they construct.
//
// Keeping this module free of fill/text/image imports is what lets the `/shapes` entry tree-shake
// the text + image renderers (and the babylon-lite-gl texture path they pull in) away entirely.

import { type GLEngineContext, createGLEngine } from "@babylonjs/lite-gl";
import type { Prop } from "../animation/lottie-raw.js";
import type { ParsedAnimation, ParsedLayer, Transform } from "../animation/parse.js";
import type { LayerRenderContext, LayerRenderer } from "../rendering/layer-renderer.js";
import { sampleScalar, sampleMulti } from "../animation/sample.js";
import { lottieTransform, multiply, type Mat2D } from "../animation/matrix.js";
import { beginGLFrame, endGLFrame, type GLScissorRect } from "../rendering/gl-frame.js";

/**
 * Runtime handle for a Lottie player — returned by the player factories (`createLottiePlayer` /
 * `createShapePlayer`) and passed back to {@link renderLottieFrame}, {@link isPlayerReady}, and
 * {@link disposePlayer}. Its fields are internal engine + parse state; treat it as opaque.
 */
export interface LottiePlayer {
    engine: GLEngineContext;
    anim: ParsedAnimation;
    /** Active renderers keyed by Lottie layer kind. Only detected kinds are present. */
    renderers: Map<number, LayerRenderer>;
    /** Layer lookup by `ind`, for resolving parent transform chains. */
    byInd: Map<number, ParsedLayer>;
    /** Per-frame memo of each layer's local world matrix (parent chain applied, pre-global). */
    worldCache: Map<number, Mat2D>;
    // Per-frame ordered command list (renderer + token), rebuilt each frame in z-order.
    cmdRenderers: LayerRenderer[];
    cmdTokens: number[];
    cmdMatteTokens: number[];
    // Transform scratch.
    a: number[];
    p: number[];
    s: number[];
}

/**
 * Create a WebGL2 engine configured for the vector Lottie player: a multisampled,
 * stencil-backed default framebuffer with premultiplied transparent output. The
 * stencil-then-cover fill renderer requires the stencil buffer; `antialias` provides
 * multisampled edge coverage directly on the canvas.
 */
export function createVectorEngine(canvas: HTMLCanvasElement | OffscreenCanvas): GLEngineContext {
    return createGLEngine(canvas, {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        stencil: true,
        depth: false,
        preserveDrawingBuffer: false,
    });
}

/**
 * Assemble a {@link LottiePlayer} from a parsed animation and a prepared renderers map. The
 * internal seam the two player factories share: the full player passes fill + text + image
 * renderers, the shapes-only player passes just the fill renderer.
 * @internal
 */
export function buildPlayer(engine: GLEngineContext, anim: ParsedAnimation, renderers: Map<number, LayerRenderer>): LottiePlayer {
    const byInd = new Map<number, ParsedLayer>();
    for (const layer of anim.layers) {
        byInd.set(layer.ind, layer);
    }
    return {
        engine,
        anim,
        renderers,
        byInd,
        worldCache: new Map(),
        cmdRenderers: [],
        cmdTokens: [],
        cmdMatteTokens: [],
        a: [0, 0],
        p: [0, 0],
        s: [100, 100],
    };
}

function samplePoint(prop: Prop | undefined, frame: number, dx: number, dy: number, out: number[]): void {
    out[0] = dx;
    out[1] = dy;
    sampleMulti(prop, frame, out);
}

function transformMatrix(t: Transform, frame: number, a: number[], p: number[], s: number[]): Mat2D {
    samplePoint(t.a, frame, 0, 0, a);
    samplePoint(t.p, frame, 0, 0, p);
    samplePoint(t.s, frame, 100, 100, s);
    const r = sampleScalar(t.r, frame, 0);
    return lottieTransform(a, p, s, r);
}

/**
 * Resolve a layer's local world matrix (parent chain applied, before the global projection).
 * A child's transform is composed under its parent's: world = parentWorld × localTransform.
 * Lottie parenting inherits only the transform, not opacity. Memoized per frame via `worldCache`.
 */
function resolveWorld(pl: LottiePlayer, layer: ParsedLayer, frame: number, depth: number): Mat2D {
    const cached = pl.worldCache.get(layer.ind);
    if (cached) {
        return cached;
    }
    const local = transformMatrix(layer.transform, frame, pl.a, pl.p, pl.s);
    let world = local;
    // Guard against cycles / runaway depth in malformed files.
    if (layer.parent !== undefined && depth < 32) {
        const parent = pl.byInd.get(layer.parent);
        if (parent) {
            world = multiply(resolveWorld(pl, parent, frame, depth + 1), local);
        }
    }
    pl.worldCache.set(layer.ind, world);
    return world;
}

/** True once every active renderer's GPU effects have compiled. Until then `renderLottieFrame`
 *  is a no-op (lite-gl effects compile asynchronously). */
export function isPlayerReady(pl: LottiePlayer): boolean {
    for (const r of pl.renderers.values()) {
        if (!r.isReady()) {
            return false;
        }
    }
    return true;
}

/** Render the animation at `frame` (comp frames) into the engine's canvas. No-op until all
 *  renderers are ready. Returns whether a frame was drawn. */
export function renderLottieFrame(pl: LottiePlayer, frame: number): boolean {
    if (!isPlayerReady(pl)) {
        return false;
    }
    const { engine, anim, renderers } = pl;
    const w = engine.canvas.width;
    const h = engine.canvas.height;
    const scale = Math.min(w / anim.width, h / anim.height);
    const ox = (w - anim.width * scale) * 0.5;
    const oy = (h - anim.height * scale) * 0.5;
    const global: Mat2D = [scale, 0, 0, scale, ox, oy];
    const ctx: LayerRenderContext = { frame, screenW: w, screenH: h };

    for (const r of renderers.values()) {
        r.beginFrame(ctx);
    }
    pl.cmdRenderers.length = 0;
    pl.cmdTokens.length = 0;
    pl.cmdMatteTokens.length = 0;
    pl.worldCache.clear();

    // Lottie renders layers back-to-front: iterate in reverse array order.
    for (let li = anim.layers.length - 1; li >= 0; li--) {
        const layer = anim.layers[li];
        if (frame < layer.ip || frame >= layer.op) {
            continue;
        }
        if (layer.matteOnly) {
            continue;
        }
        const renderer = renderers.get(layer.kind);
        if (!renderer) {
            continue;
        }
        const layerAlpha = sampleScalar(layer.transform.o, frame, 100) / 100;
        if (layerAlpha <= 0.0001) {
            continue;
        }
        let matteToken = -1;
        if (layer.matteMode !== undefined) {
            if (layer.matteMode !== 1 || layer.matteSource === undefined) {
                continue;
            }
            const matte = pl.byInd.get(layer.matteSource);
            if (!matte || frame < matte.ip || frame >= matte.op || renderers.get(matte.kind) !== renderer) {
                continue;
            }
            const matteAlpha = sampleScalar(matte.transform.o, frame, 100) / 100;
            if (matteAlpha <= 0.0001) {
                continue;
            }
            const matteWorld = multiply(global, resolveWorld(pl, matte, frame, 0));
            matteToken = renderer.emitLayer(matte, matteWorld, matteAlpha, ctx);
            if (matteToken < 0) {
                continue;
            }
        }
        const world = multiply(global, resolveWorld(pl, layer, frame, 0));
        const token = renderer.emitLayer(layer, world, layerAlpha, ctx);
        if (token < 0) {
            continue;
        }
        pl.cmdRenderers.push(renderer);
        pl.cmdTokens.push(token);
        pl.cmdMatteTokens.push(matteToken);
    }

    for (const r of renderers.values()) {
        r.flush(ctx);
    }

    // Clip to the comp bounds: Lottie content beyond the composition rect is not shown.
    // Flip Y to WebGL's lower-left scissor origin.
    const sx = Math.max(0, Math.floor(ox));
    const syTop = Math.max(0, Math.floor(oy));
    const cw = Math.min(w - sx, Math.ceil(anim.width * scale));
    const chh = Math.min(h - syTop, Math.ceil(anim.height * scale));
    const scissor: GLScissorRect = { x: sx, y: h - (syTop + chh), width: cw, height: chh };

    beginGLFrame(engine, scissor);
    for (let i = 0; i < pl.cmdRenderers.length; i++) {
        const matteToken = pl.cmdMatteTokens[i];
        pl.cmdRenderers[i].recordLayer(pl.cmdTokens[i], matteToken >= 0 ? matteToken : undefined);
    }
    endGLFrame(engine);
    return true;
}

/** Dispose all renderers (and their GPU resources). The engine is owned by the caller. */
export function disposePlayer(pl: LottiePlayer): void {
    for (const r of pl.renderers.values()) {
        r.dispose();
    }
    pl.renderers.clear();
}
