import type { ImageProcessingConfig, SceneContext } from "./scene-core.js";
import { rebuildScenePbrPipelines } from "./scene-rebuild.js";
import { StandardToneMapping } from "../material/pbr/tone-mapping.js";

/** Fields of {@link ImageProcessingConfig} that may be updated at runtime via {@link setSceneImageProcessing}. */
export type ImageProcessingUpdate = Partial<ImageProcessingConfig>;

/**
 * Update a scene's image-processing configuration after registration, rebuilding the
 * pipelines that bake image-processing state into their shaders only when necessary.
 *
 * Cost tiers:
 *  - `exposure` / `contrast` are read live from the scene UBO every frame — changing them
 *    takes effect on the next frame with no rebuild.
 *  - `toneMappingEnabled` and `toneMapping` are compile-time PBR shader features. Changing
 *    either recompiles the affected PBR pipelines (via {@link rebuildScenePbrPipelines}).
 *
 * The rebuild is skipped when the scene has not been built yet (its first build will pick
 * up the new configuration) or when only live UBO fields changed.
 *
 * @param scene - The registered scene to update.
 * @param update - Partial image-processing configuration to merge into the scene.
 */
export async function setSceneImageProcessing(scene: SceneContext, update: ImageProcessingUpdate): Promise<void> {
    const ip = scene.imageProcessing;

    // An undefined `toneMapping` resolves to the default StandardToneMapping in the PBR builder, so compare
    // by the EFFECTIVE algorithm id (undefined -> standard). Comparing the raw `toneMapping?.id` would treat
    // switching between `undefined` and `StandardToneMapping` as a change and trigger a needless rebuild.
    const prevEnabled = ip.toneMappingEnabled;
    const prevToneMappingId = ip.toneMapping?.id ?? StandardToneMapping.id;

    Object.assign(ip, update);

    const enabledChanged = ip.toneMappingEnabled !== prevEnabled;
    const nextToneMappingId = ip.toneMapping?.id ?? StandardToneMapping.id;
    const toneMappingChanged = ip.toneMappingEnabled && nextToneMappingId !== prevToneMappingId;

    if (enabledChanged || toneMappingChanged) {
        await rebuildScenePbrPipelines(scene);
    }
}
