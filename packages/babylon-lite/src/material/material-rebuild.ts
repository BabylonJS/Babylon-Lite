import type { SceneContext } from "../scene/scene.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Material } from "./material.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { getMaterialSource, isMaterialView } from "./material-view.js";
import { resolveMeshRebuild } from "./resolve-mesh-rebuild.js";
import { processMaterialSwaps } from "../scene/scene-material-swap.js";

export interface RebuildMaterialOptions {
    /** Rebuild views created from the same source material. Defaults to true. */
    rebuildViews?: boolean;
    /** Rebuild the frame graph after material renderables are refreshed. Defaults to false so callers can batch updates. */
    rebuildFrameGraph?: boolean;
}

interface DetachablePacket {
    _disposed?: boolean;
    _owner?: DetachablePacket[];
    _onOwnerEmpty?: () => void;
}

type DetachableDisposer = (() => void) & { p?: DetachablePacket };

type RebuildsComposed = typeof import("./pbr/pbr-built-variant.js")._pbrRebuildsComposed;
/** The PBR check: the first PBR material rebuild starts importing it and rebuilds the group; later ones call it. */
let _rebuildsComposed: RebuildsComposed | undefined;

/** Rebuild renderables whose pipeline/bind-group feature state depends on a material.
 *  Use after texture, sampler, bind-group layout, culling, or feature changes.
 *  UBO-only scalar/vector changes should use markMaterialUboDirty instead. */
export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): void | Promise<void> {
    const completion = rebuildMaterialRenderables(scene, materialOrView, options);
    if (completion) {
        void completion.catch((error) => {
            scene._runtimeBuilds?._x(error);
            console.error(error);
        });
    }
    return completion;
}

function rebuildMaterialRenderables(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): Promise<void> | undefined {
    const source = getMaterialSource(materialOrView);
    (source as { _renderFeatures?: unknown })._renderFeatures = undefined;
    const rebuildViews = options?.rebuildViews !== false;
    const pending: Promise<void>[] = [];
    const extra = scene._materialRebuild?.((material) => matchesMaterial(material, source, materialOrView, rebuildViews));
    if (extra) {
        pending.push(extra);
    }

    const targets = scene.meshes.filter((mesh) => matchesMaterial(mesh.material, source, materialOrView, rebuildViews));
    const pbr = targets.filter((mesh) => mesh.material!._buildGroup._materialFamily === "pbr");
    // A PBR mesh rebuilds its whole group, unless every PBR mesh of the material can be rebuilt on its own with a variant
    // its group already composed: then they are rebuilt like material assignments, without rebuilding the other PBR
    // meshes of the scene and the frame graph. The check is decided synchronously, so a request joins a pending group
    // rebuild exactly when it did without it; the first PBR material rebuild only starts importing it.
    let perMesh = false;
    if (pbr[0] && _rebuildsComposed) {
        try {
            perMesh = _rebuildsComposed(scene, pbr);
        } catch (error) {
            pending.push(Promise.reject(error as Error));
        }
    } else if (pbr[0]) {
        void import("./pbr/pbr-built-variant.js").then(
            ({ _pbrRebuildsComposed }) => {
                _rebuildsComposed = _pbrRebuildsComposed;
            },
            () => undefined
        );
    }
    if (perMesh) {
        const swapped = new Set(pbr);
        rebuildEach(
            scene,
            targets.filter((mesh) => !swapped.has(mesh)),
            pending
        );
        swapNow(scene, pbr, pending);
    } else {
        rebuildEach(scene, targets, pending);
    }

    if (pending.length > 0) {
        return Promise.all(pending).then(() => {
            if (options?.rebuildFrameGraph) {
                scene._frameGraph.build();
            }
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

/** Rebuild each mesh through its family's path, collecting the asynchronous rebuilds in `pending`. */
function rebuildEach(scene: SceneContext, meshes: readonly Mesh[], pending: Promise<void>[]): void {
    let changed = false;
    for (const mesh of meshes) {
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
    if (changed) {
        scene._renderableVersion++;
        scene._materialEpoch++; // material renderables (and their UBOs) were rebuilt → bump the material epoch
    }
}

/** Drain the material-swap queue for `meshes` alone, now: each is rebuilt through its group closure, as a material
 *  assignment is. Meshes queued for other reasons keep their place for the next frame's drain. */
function swapNow(scene: SceneContext, meshes: readonly Mesh[], pending: Promise<void>[]): void {
    const queue = scene._materialSwapQueue;
    const own = new Set(meshes);
    const others = queue.filter((mesh) => !own.has(mesh));
    queue.length = 0;
    queue.push(...meshes);
    try {
        const drained = processMaterialSwaps(scene);
        if (drained) {
            pending.push(drained);
        }
    } catch (error) {
        // Report it once, and rebuild the meshes with the group instead of leaving them queued for the frame drain to
        // rethrow every frame. The drain already retired the failing mesh's renderable, so it shows again once that
        // group rebuild commits.
        queue.length = 0;
        pending.push(Promise.reject(error as Error));
        rebuildEach(scene, meshes, pending);
    } finally {
        queue.push(...others);
    }
}

function rebuildSceneMesh(ctx: SceneContext, mesh: Mesh): boolean | Promise<void> {
    const material = mesh.material;
    if (!material) {
        return false;
    }
    const builder = material._buildGroup;
    const group = ctx._groups.get(builder);
    const preload = (material as Material & { _uvTxExt?: Promise<void> })._uvTxExt;
    if (preload || mesh._runtimeThinBuild || ctx._runtimeBuilds?.w || (builder._materialFamily === "pbr" && (ctx._built || group?.r))) {
        if (!ctx._built && !group?.r) {
            return false;
        }
        return Promise.resolve(preload)
            .then(() => import("../scene/scene-runtime-mesh-build.js"))
            .then(({ B }) => B(ctx, builder, mesh))
            .then(() => ctx._runtimeBuilds?._e(false));
    }
    const resolved = resolveMeshRebuild(ctx, builder);
    if (!resolved) {
        return false;
    }
    const old = ctx._meshDisposables.get(mesh);
    if (old) {
        ctx._meshDisposables.delete(mesh);
        for (const dispose of old) {
            const lifetimeIndex = ctx._disposables.indexOf(dispose);
            if (lifetimeIndex >= 0) {
                ctx._disposables.splice(lifetimeIndex, 1);
            }
            const packet = (dispose as DetachableDisposer).p;
            if (packet) {
                packet._disposed = true;
                const owner = packet._owner;
                if (owner) {
                    const index = owner.indexOf(packet);
                    if (index >= 0) {
                        owner.splice(index, 1);
                    }
                    packet._owner = undefined;
                    if (owner.length === 0) {
                        packet._onOwnerEmpty?.();
                    }
                } else {
                    packet._onOwnerEmpty?.();
                }
                if (packet._onOwnerEmpty) {
                    packet._onOwnerEmpty = undefined;
                }
            }
        }
        retireGpuResources(ctx.surface.engine, () => old.forEach((fn) => fn()));
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
