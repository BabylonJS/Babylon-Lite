import type { SceneContext } from "./scene-core.js";
import type { Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): Promise<void> | void {
    const q = scene._materialSwapQueue;
    if (!q[0]) {
        return;
    }
    if (scene._runtimeBuilds?.w) {
        return;
    }
    let changed: number | undefined;
    let pending: Promise<void> | undefined;
    const renderables = scene._renderables;
    for (const mesh of q) {
        const mat = mesh.material;
        const runtimeBuild = mat && mesh._runtimeThinBuild;
        if (runtimeBuild) {
            pending = runtimeBuild(scene, mesh, pending);
            continue;
        }
        const group = mat && scene._groups.get(mat._buildGroup);
        const rebuild = group?.r;
        if (!rebuild) {
            continue;
        }

        const old = scene._meshDisposables.get(mesh);
        if (old) {
            scene._meshDisposables.delete(mesh);
            // These disposables free the OLD renderable's GPU resources (per-mesh/material UBOs, the
            // GPU-cull state buffers, texture releases). They must NOT run synchronously: the old buffers
            // may still be referenced by the next frame command buffer, and destroying them now hits the
            // validation error "Buffer used in submit while destroyed" (seen when a
            // plugin / shadow-receiver variant change swaps a planted mesh's material — e.g. planting a
            // fern or agave). The new renderable is rebuilt below and replaces the old one, so nothing
            // records the old resources again; retire the teardown after the next submitted frame drains.
            retireGpuResources(scene.surface.engine, () => old.forEach((fn) => fn()));
        }
        const o = group.o;
        let dead: Renderable | undefined;
        for (let i = renderables.length; i--;) {
            if (renderables[i]!.mesh === mesh) {
                dead = renderables.splice(i, 1)[0];
            }
        }

        // Per-material generation: the CSM caster-view cache keys off THIS (which material was rebuilt), not the
        // global _materialEpoch (which also bumps when an unrelated material is swapped), so swapping a non-caster
        // material doesn't force a full shadow rebuild. See ensureCsmShadowTaskState.
        mat._csmGen = 1 + (mat._csmGen || 0);
        const built = rebuild(scene, mesh);
        // Keep the group's tracked output in sync (see SceneMeshGroup.o): a topology rebuild drops the
        // previous output by identity, so a swap-built renderable missing from `o` would survive it and
        // double-draw (NodeMaterial's opaque output is merged and carries no `mesh` to match on). The
        // superseded entry is REPLACED, not appended, so repeated swaps cannot retain dead renderables.
        if (o) {
            const oi = dead ? o.indexOf(dead) : -1;
            oi < 0 ? o.push(built) : (o[oi] = built);
        }
        changed = renderables.push(built);
    }
    if (changed) {
        renderables.sort((a, b) => a.order - b.order);
        scene._renderableVersion++;
        scene._materialEpoch++; // a caster's material UBOs were rebuilt → CSM-style view caches must fully rebuild
    }
    q.length = 0;
    return pending;
}
