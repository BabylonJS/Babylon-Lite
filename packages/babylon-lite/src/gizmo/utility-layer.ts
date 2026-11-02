/** UtilityLayer — a second SceneContext that renders on top of a main scene,
 *  sharing the canvas + camera but with its own depth buffer.  Used to host
 *  gizmo meshes so they always appear in front of regular scene content.
 *
 *  Implementation notes:
 *   • Built on top of Lite's existing multi-scene support — when a second
 *     scene is registered with the engine, the swapchain overlay path is
 *     activated automatically (color `loadOp = "load"`).
 *   • The utility scene gets its own render-target depth attachment which is
 *     freshly cleared at the start of its render pass (depth `loadOp = "clear"`
 *     in the render-pass code), so depth tests inside the overlay are local.
 *   • The utility scene's `camera` is set to the same reference as the main
 *     scene's camera, so it inherits view + projection automatically. */

import { isRenderingContextRegistered } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addToScene, createSceneContext, disposeScene, onBeforeRender, registerScene } from "../scene/scene-core.js";
import { enableUtilityLayerOverlays, moveSwapchainOverlaysAfterBase } from "./utility-layer-overlay.js";
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
    const scene = createSceneContext(mainScene.surface);
    scene.name = "UtilityLayer";
    scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
    scene._overlayBase = mainScene;
    enableUtilityLayerOverlays(mainScene.surface.engine);

    // Without its main scene on the surface there is nothing to composite onto, so stay inert.
    const isActive = (): boolean => {
        for (let base: SceneContext | undefined = mainScene; base; base = base._overlayBase) {
            if (!isRenderingContextRegistered(scene.surface, base)) {
                return false;
            }
        }
        return true;
    };
    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isActive()) {
            update();
        } else {
            scene._drawCallsPre = 0;
        }
    };
    scene._record = () => (isActive() ? record() : 0);

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
