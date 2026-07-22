import type { SceneContext } from "./scene-core.js";
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
        const runtimeBuild = mesh._runtimeThinBuild;
        if (runtimeBuild) {
            pending = runtimeBuild(scene, mesh, pending);
            continue;
        }
        const mat = mesh.material;
        const rebuild = scene._groups.get(mat._buildGroup)?.r;
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
        for (let i = renderables.length; i--;) {
            if (renderables[i]!.mesh === mesh) {
                renderables.splice(i, 1);
            }
        }

        // Per-material generation: the CSM caster-view cache keys off THIS (which material was rebuilt), not the
        // global _materialEpoch (which also bumps when an unrelated material is swapped), so swapping a non-caster
        // material doesn't force a full shadow rebuild. See ensureCsmShadowTaskState.
        mat._csmGen = -~mat._csmGen!;
        changed = renderables.push(rebuild(scene, mesh));
    }
    if (changed) {
        renderables.sort((a, b) => a.order - b.order);
        scene._renderableVersion++;
        scene._materialEpoch++; // a caster's material UBOs were rebuilt → CSM-style view caches must fully rebuild
    }
    q.length = 0;
    return pending;
}
