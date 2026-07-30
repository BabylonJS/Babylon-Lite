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
    (source as { _renderFeatures?: unknown })._renderFeatures = undefined;
    const rebuildViews = options?.rebuildViews !== false;
    let changed = false;
    const pending: Promise<void>[] = [];

    for (const mesh of scene.meshes) {
        if (matchesMaterial(mesh.material, source, materialOrView, rebuildViews)) {
            const rebuilt = rebuildSceneMesh(scene, mesh);
            if (typeof rebuilt !== "boolean") {
                pending.push(rebuilt);
            } else if (rebuilt && mesh.material) {
                // Per-material generation (twin of scene-material-swap): lets the CSM detect when a CASTER's own
                // material was rebuilt — and ONLY then rebuild its shadow views — instead of on the global epoch.
                mesh.material._csmGen = (mesh.material._csmGen ?? 0) + 1;
                changed = true;
            }
        }
    }

    if (changed) {
        scene._renderableVersion++;
        scene._materialEpoch++; // material renderables (and their UBOs) were rebuilt → bump the material epoch
    }
    if (pending.length > 0) {
        void Promise.all(pending)
            .then(() => {
                if (options?.rebuildFrameGraph) {
                    scene._frameGraph.build();
                }
            })
            .catch((error) => {
                scene._runtimeBuilds?._x(error);
                console.error(error);
            });
    } else if (options?.rebuildFrameGraph) {
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

function rebuildSceneMesh(ctx: SceneContext, mesh: Mesh): boolean | Promise<void> {
    const material = mesh.material;
    if (!material) {
        return false;
    }
    const builder = material._buildGroup;
    const group = ctx._groups.get(builder);
    if (mesh._runtimeThinBuild || ctx._runtimeBuilds?.w || (builder._materialFamily === "pbr" && (ctx._built || group?.r))) {
        if (!ctx._built && !group?.r) {
            return false;
        }
        return import("../scene/scene-runtime-mesh-build.js").then(({ B }) => B(ctx, builder, mesh)).then(() => ctx._runtimeBuilds?._e(false));
    }
    const resolved = group ? group.r : builder._rebuildSingle;
    if (!resolved) {
        return false;
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
    const renderable = resolved(ctx, mesh);
    let i = ctx._renderables.length;
    while (i > 0 && ctx._renderables[i - 1]!.order > renderable.order) {
        i--;
    }
    ctx._renderables.splice(i, 0, renderable);
    return true;
}
