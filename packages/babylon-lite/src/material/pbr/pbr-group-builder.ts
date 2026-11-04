import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { SceneContext } from "../../scene/scene.js";

let _pbrGroupBuilder: MeshGroupBuilder | null = null;

/** Lazily create the shared PBR group builder without retaining the user-material factory. */
export function getPbrGroupBuilder(): MeshGroupBuilder {
    if (_pbrGroupBuilder) {
        return _pbrGroupBuilder;
    }
    const builder: MeshGroupBuilder = async (scene, meshes) => {
        const envTex = (scene as SceneContext)._envTextures;
        const renderableMod = await import("./pbr-renderable.js");
        const result = await renderableMod.buildPbrRenderables(scene, meshes, envTex);
        builder._rebuildSingle = result.rebuildSingle;
        return result;
    };
    builder._materialFamily = "pbr";
    return (_pbrGroupBuilder = builder);
}
