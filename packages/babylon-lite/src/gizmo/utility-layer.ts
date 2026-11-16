/** UtilityLayer — an overlay scene that renders on top of a main scene,
 *  sharing the canvas + camera but with its own depth buffer.  Used to host
 *  gizmo meshes so they always appear in front of regular scene content.
 *
 *  Implementation notes:
 *   • Built on `createOverlayScene`, which composites onto the main scene and
 *     keeps the layer immediately after it in the surface's render order.
 *   • The utility scene gets its own render-target depth attachment which is
 *     freshly cleared at the start of its render pass (depth `loadOp = "clear"`
 *     in the render-pass code), so depth tests inside the overlay are local.
 *   • The utility scene's `camera` is set to the same reference as the main
 *     scene's camera, so it inherits view + projection automatically. */

import { isRenderingContextRegistered } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addToScene, disposeScene, onBeforeRender, registerScene } from "../scene/scene-core.js";
import { createOverlayScene, moveSwapchainOverlaysAfterBase } from "../scene/overlay-scene.js";
import { createHemisphericLight } from "../light/hemispheric.js";

/** UtilityLayer handle. The `scene` field is a regular `SceneContext` — pass it
 *  to gizmo factories so their meshes are added there instead of the main
 *  scene. */
export interface UtilityLayer {
    readonly scene: SceneContext;
    readonly mainScene: SceneContext;
}

/** Options used when creating a utility layer for gizmos and overlays. */
export interface UtilityLayerOptions {
    /** Add a built-in hemispheric light so gizmo materials are visible without
     *  the caller adding one. Defaults to true. */
    addDefaultLight?: boolean;
    /** Default light intensity when `addDefaultLight` is true. Defaults to 1.0. */
    lightIntensity?: number;
}

/** Create a utility layer attached to the main scene's surface.
 *  The returned `scene` shares the main scene's camera so view + projection
 *  remain in sync without manual mirroring.  The utility scene renders with a
 *  fresh-cleared depth buffer (so its gizmos appear on top of the main scene)
 *  while keeping NORMAL intra-layer depth testing — solid gizmo bodies (e.g.
 *  the camera-gizmo box + cylinders) occlude their own back faces correctly. */
export function createUtilityLayer(mainScene: SceneContext, options?: UtilityLayerOptions): UtilityLayer {
    const scene = createOverlayScene(mainScene);
    scene.name = "UtilityLayer";

    // Share the main scene's camera by reference. If the main scene swaps its
    // camera at runtime we forward that change to the utility scene each frame.
    scene.camera = mainScene.camera;
    onBeforeRender(scene, () => {
        if (scene.camera !== mainScene.camera) {
            scene.camera = mainScene.camera;
        }
    });

    if (options?.addDefaultLight !== false) {
        // Match BJS `UtilityLayerRenderer._getSharedGizmoLight`: a hemispheric
        // light pointing up with intensity 2 and a gray ground colour, so gizmo
        // meshes are evenly lit (down-facing faces aren't left black).
        const light = createHemisphericLight([0, 1, 0]);
        light.intensity = options?.lightIntensity ?? 2;
        light.groundColor = [0.5, 0.5, 0.5];
        addToScene(scene, light);
    }

    return { scene, mainScene };
}

/** Register the utility layer immediately after its main scene and earlier layers.
 *  While the main scene is not registered the layer stays registered but renders
 *  nothing; the order is restored when the main scene is registered again. */
export async function registerUtilityLayer(utility: UtilityLayer): Promise<void> {
    await registerScene(utility.scene);
    if (isRenderingContextRegistered(utility.scene.surface, utility.scene)) {
        moveSwapchainOverlaysAfterBase(utility.mainScene);
    }
}

/** Dispose the utility layer's underlying scene. Idempotent. */
export function disposeUtilityLayer(utility: UtilityLayer): void {
    disposeScene(utility.scene);
}
