import type { AssetContainer } from "../asset-container.js";
import type { SceneContext } from "../scene/scene-core.js";

/** @internal Register one feature-owned cleanup for a container in a scene. */
export function _registerAssetContainerSceneCleanup(container: AssetContainer, scene: SceneContext, cleanup: () => void): void {
    const cleanups = (container._sceneCleanups ??= new WeakMap());
    const previous = cleanups.get(scene);
    const combined = previous
        ? () => {
              previous();
              cleanup();
          }
        : cleanup;
    if (previous) {
        scene._disposables[scene._disposables.indexOf(previous)] = combined;
    } else {
        scene._disposables.push(combined);
    }
    cleanups.set(scene, combined);
}
