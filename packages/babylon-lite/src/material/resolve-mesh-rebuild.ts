import type { MeshGroupBuilder } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene.js";

/** @internal Resolve only this scene's completed build or an explicitly scene-independent factory. */
export function resolveMeshRebuild(scene: SceneContext, builder: MeshGroupBuilder): MeshGroupBuilder["_rebuildSingle"] {
    const group = scene._groups.get(builder);
    return group ? group.r : builder._sceneIndependentRebuild ? builder._rebuildSingle : undefined;
}
