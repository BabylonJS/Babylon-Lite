import type { SceneContext } from "../scene/scene.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "./material.js";
import { getMaterialSource, isMaterialView } from "./material-view.js";

export interface RebuildMaterialOptions {
    /** Rebuild views created from the same source material. Defaults to true. */
    rebuildViews?: boolean;
    /** Rebuild the frame graph after material renderables are refreshed. Defaults to false so callers can batch updates. */
    rebuildFrameGraph?: boolean;
}

/** Rebuild renderables whose pipeline/bind-group feature state depends on a material.
 *  Use after texture, sampler, bind-group layout, culling, or feature changes.
 *  UBO-only scalar/vector changes should use markMaterialUboDirty instead. */
export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): void {
    const source = getMaterialSource(materialOrView);
    const rebuildViews = options?.rebuildViews !== false;
    let changed = false;

    for (const mesh of scene.meshes) {
        if (matchesMaterial(mesh.material, source, materialOrView, rebuildViews)) {
            rebuildSceneMesh(scene, mesh);
            changed = true;
        }
    }

    if (changed) {
        scene._renderableVersion++;
    }
    if (options?.rebuildFrameGraph) {
        scene._frameGraph.build();
    }
}

function matchesMaterial(meshMaterial: Material | null, source: Material, materialOrView: Material, rebuildViews: boolean): boolean {
    if (!meshMaterial) {
        return false;
    }
    if (!rebuildViews) {
        return meshMaterial === materialOrView;
    }
    return meshMaterial === source || (isMaterialView(meshMaterial) && meshMaterial.source === source);
}

function rebuildSceneMesh(ctx: SceneContext, mesh: Mesh): void {
    const material = mesh.material;
    if (!material) {
        return;
    }
    const rebuild = material._buildGroup._rebuildSingle;
    if (!rebuild) {
        return;
    }
    const old = ctx._meshDisposables.get(mesh);
    if (old) {
        for (const fn of old) {
            fn();
        }
        ctx._meshDisposables.delete(mesh);
    }
    for (let i = ctx._renderables.length - 1; i >= 0; i--) {
        if (ctx._renderables[i]!.mesh === mesh) {
            ctx._renderables.splice(i, 1);
        }
    }
    const renderable = rebuild(ctx, mesh);
    let i = ctx._renderables.length;
    while (i > 0 && ctx._renderables[i - 1]!.order > renderable.order) {
        i--;
    }
    ctx._renderables.splice(i, 0, renderable);
}
