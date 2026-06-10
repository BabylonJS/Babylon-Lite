/** Shared per-binding GPU frustum-culling lifecycle for thin-instanced renderables.
 *
 *  Dynamically imported only when a scene enables thin-instance GPU culling, and
 *  it statically pulls in the compute-cull module — so non-culling scenes fetch
 *  neither this helper nor `thin-instance-gpu-culling.ts`.
 *
 *  Factored here so Standard, PBR, and ShaderMaterial renderables share one
 *  implementation of the cull lifecycle instead of copy-pasting it three times.
 *  `tryBind` is the single seam a renderable's `bind()` calls: it does the
 *  opaque-only gate + per-mesh `_gpuCullingEnabled` check, marks the renderable
 *  `_direct` (read by the render task's buildBindings right after `bind()`
 *  returns), and creates the per-binding state. The renderable then reads
 *  `cullDrawBufs` for the compacted instance source and calls `binding.draw(...)`
 *  for the indirect-vs-fallback draw call. Keeping these few seams tiny is what
 *  lets non-culling scenes — which still fetch the per-material renderable
 *  chunks — stay within their bundle-size ceilings. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene.js";
import type { DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { Mesh } from "./mesh.js";
import type { ThinInstanceDrawBuffers } from "./thin-instance-gpu.js";
import { createTiCullState, destroyTiCullState, prepareTiCull } from "./thin-instance-gpu-culling.js";

/** Per-binding cull lifecycle. The renderable's `bind()` obtains one from
 *  `tryBind`, uses `update` as the binding's update, reads `cullDrawBufs` (the
 *  compacted instance source) and calls `draw()` for the final draw call. */
export interface TiCullBinding {
    /** Run the binding's base update, then dispatch the compute cull pass and stash the result. */
    update(context: DrawUpdateContext): void;
    /** Compacted visible-instance buffers, or null to fall back to a full instanced draw. */
    cullDrawBufs: ThinInstanceDrawBuffers | null;
    /** @internal Indirect draw-args buffer (null until/unless culling ran this frame). */
    _args: GPUBuffer | null;
    /** Issue the indirect (culled) draw when visible instances were compacted, else a full instanced draw. */
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indexCount: number, instanceCount: number): void;
}

/** Create a per-binding cull lifecycle for one thin-instanced renderable binding,
 *  iff the mesh opts in and is not excluded (transparent / transmissive — v1 is
 *  opaque-only). Marks the renderable `_direct` so it leaves the cached opaque
 *  bundle; this is safe to do during `bind()` because buildBindings reads
 *  `_direct` only after `bind()` returns. Returns undefined when culling does not
 *  apply, so the caller falls back to a normal instanced draw. */
export function tryBind(
    renderable: Renderable,
    scene: SceneContext,
    mesh: Mesh,
    engine: EngineContext,
    hasColor: boolean,
    excluded: boolean,
    baseUpdate: ((context: DrawUpdateContext) => void) | undefined
): TiCullBinding | undefined {
    const ti = mesh.thinInstances;
    if (excluded || !ti?._gpuCullingEnabled) {
        return undefined;
    }
    (renderable as { _direct?: boolean })._direct = true;
    const state = createTiCullState();
    scene._meshDisposables.get(mesh)?.push(() => {
        destroyTiCullState(state);
    });
    const binding: TiCullBinding = {
        cullDrawBufs: null,
        _args: null,
        update(context: DrawUpdateContext): void {
            baseUpdate?.(context);
            const res = prepareTiCull(engine, state, mesh, mesh._gpu, ti, hasColor, context);
            binding.cullDrawBufs = res?.drawBuffers ?? null;
            binding._args = res?.argsBuffer ?? null;
        },
        draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indexCount: number, instanceCount: number): void {
            if (binding._args) {
                pass.drawIndexedIndirect(binding._args, 0);
            } else {
                pass.drawIndexed(indexCount, instanceCount);
            }
        },
    };
    return binding;
}
