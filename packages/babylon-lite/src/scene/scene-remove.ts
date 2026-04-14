import type { SceneContext, SceneContextInternal } from "./scene-core.js";
import type { Mesh, MeshInternal } from "../mesh/mesh.js";

/** Remove a mesh from the scene and destroy its GPU resources.
 *  Standalone function for tree-shaking — only included when actually used. */
export function removeFromScene(scene: SceneContext, mesh: Mesh): void {
    const sc = scene as SceneContextInternal;
    const fns = sc._meshDisposables.get(mesh);
    if (fns) {
        for (const fn of fns) {
            fn();
        }
        sc._meshDisposables.delete(mesh);
    }
    const mi2 = scene.meshes.indexOf(mesh);
    if (mi2 >= 0) {
        scene.meshes.splice(mi2, 1);
    }
    for (const arr of [sc._opaqueRenderables, sc._transparentRenderables, sc._renderables]) {
        const i = arr.findIndex((r) => r.mesh === mesh);
        if (i >= 0) {
            arr.splice(i, 1);
        }
    }
    const g = (mesh as MeshInternal)._gpu;
    g.positionBuffer.destroy();
    g.normalBuffer.destroy();
    g.uvBuffer.destroy();
    g.indexBuffer.destroy();
    g.tangentBuffer?.destroy();
    g.uv2Buffer?.destroy();
    const sk = mesh.skeleton;
    if (sk) {
        sk.boneTexture.destroy();
        sk.jointsBuffer.destroy();
        sk.weightsBuffer.destroy();
        sk.joints1Buffer?.destroy();
        sk.weights1Buffer?.destroy();
    }
    if (mesh.morphTargets) {
        mesh.morphTargets.texture.destroy();
        mesh.morphTargets.weightsBuffer.destroy();
    }
}
