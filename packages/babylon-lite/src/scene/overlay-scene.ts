import type { RenderingContext } from "../engine/engine.js";
import { isRenderingContextRegistered } from "../engine/engine.js";
import { moveRenderingContext } from "../engine/rendering-context-order.js";
import type { SceneContext } from "./scene-core.js";
import { _installOverlaySceneRegistration, createSceneContext } from "./scene-core.js";
import type { RenderTarget } from "../engine/render-target.js";
import { _createRenderTargetState } from "../engine/render-target.js";
import { _createAutomaticRenderTask } from "../frame-graph/render-task-base.js";
import { _appendTask } from "../frame-graph/frame-graph.js";

/** Explicit color destinations borrowed by an overlay scene. */
export interface OverlaySceneOptions {
    rt: RenderTarget;
    rst?: RenderTarget;
}

function isOverlayDescendant(context: RenderingContext, base: SceneContext): boolean {
    let parent = (context as Partial<SceneContext>)._overlayBase;
    while (parent) {
        if (parent === base) {
            return true;
        }
        parent = parent._overlayBase;
    }
    return false;
}

function moveOverlayDescendants(base: SceneContext, baseIndex: number): number {
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    const overlays = contexts.filter((context): context is SceneContext => "_overlayBase" in context && context._overlayBase === base);
    for (const overlay of overlays) {
        baseIndex++;
        if (contexts[baseIndex] !== overlay) {
            moveRenderingContext(surface, overlay, baseIndex);
        }
        baseIndex = moveOverlayDescendants(overlay, baseIndex);
    }
    return baseIndex;
}

/** @internal Keep the overlay tree containing `scene` together, depth-first. Grouping starts at
 *  the tree's root and waits until that root is registered, so siblings keep registration order. */
export function moveSwapchainOverlaysAfterBase(scene: SceneContext): void {
    let base = scene;
    while (base._overlayBase) {
        base = base._overlayBase;
    }
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    let baseIndex = contexts.indexOf(base);
    if (baseIndex === -1) {
        return;
    }
    const firstDescendantIndex = contexts.findIndex((context) => isOverlayDescendant(context, base));
    if (firstDescendantIndex === -1) {
        return;
    }
    if (firstDescendantIndex < baseIndex) {
        moveRenderingContext(surface, base, firstDescendantIndex);
        baseIndex = firstDescendantIndex;
    }
    moveOverlayDescendants(base, baseIndex);
}

/** Whether any scene in `scene`'s explicit overlay chain is unregistered. */
function isSuspended(scene: SceneContext): boolean {
    let base = scene._overlayBase;
    while (base && isRenderingContextRegistered(scene.surface, base)) {
        base = base._overlayBase;
    }
    return !!base;
}

/**
 * Create a scene that composites over `baseScene` on the base scene's surface.
 *
 * The overlay keeps its own camera, lights, and freshly cleared depth buffer, but
 * loads the supplied color target without discovering any base-scene attachment.
 * The caller owns and initializes `rt` and `rst` before the overlay renders.
 * Register it with {@link registerScene} in either order relative
 * to the base; registration keeps every overlay immediately after its base (sibling
 * overlays in registration order, nested overlays depth-first), so later contexts such
 * as text renderers draw on top. While the base scene (or any scene in its overlay
 * chain) is not registered, the overlay stays registered but does no update or render work.
 */
export function createOverlayScene(baseScene: SceneContext, options: OverlaySceneOptions): SceneContext {
    const { rt, rst } = options;
    const desc = rt._descriptor;
    if (!desc.format) {
        throw new Error("createOverlayScene requires a color render target.");
    }
    if (rst && (desc.samples === 1 || rst === rt || rst._descriptor.samples !== 1 || rst._descriptor.format !== desc.format)) {
        throw new Error("createOverlayScene requires a distinct single-sample resolve target matching its multisample color format.");
    }
    const scene = createSceneContext(baseScene.surface, { defaultRenderTask: false });
    const depth = _createRenderTargetState(
        {
            dFormat: desc.dFormat ?? "depth24plus-stencil8",
            depthCompare: desc.depthCompare,
            depthClearValue: desc.depthClearValue,
            samples: desc.samples,
            get size() {
                return rt === baseScene.surface.scRT ? baseScene.surface : desc.size;
            },
        },
        rt._resolveSize
    );
    const task = _createAutomaticRenderTask({ name: "scene", rt, rst, depth, sharedRt: true, clr: false }, baseScene.surface.engine, scene);
    Object.assign(scene, { defaultRenderTask: task });
    _appendTask(scene._frameGraph, task);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
    scene._overlayBase = baseScene;
    _installOverlaySceneRegistration(moveSwapchainOverlaysAfterBase);

    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isSuspended(scene)) {
            scene._drawCallsPre = 0;
        } else {
            update();
        }
    };
    scene._record = () => (isSuspended(scene) ? 0 : record());
    return scene;
}
