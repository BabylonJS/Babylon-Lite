/** Standard material GPU frustum-culling patcher.
 *
 * Dynamically imported only when at least one thin-instance mesh in the scene
 * has `_gpuCullingEnabled = true`. Patches the Renderable produced by
 * `buildStandardMeshRenderables` to use GPU frustum culling + drawIndexedIndirect.
 *
 * Works by:
 * 1. Installing `_drawHook` on the ThinInstanceData so the standard draw function
 *    delegates vertex-buffer binding + draw-call to this module's implementation.
 * 2. Wrapping `r.bind` to manage per-binding cull state and run the compute cull
 *    pass each frame before the draw call. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mesh, MeshInternal } from "../../mesh/mesh.js";
import type { ThinInstanceDrawBuffers } from "../../mesh/thin-instance-gpu.js";
import type { Renderable } from "../../render/renderable.js";
import type { SceneContextInternal } from "../../scene/scene.js";

type CullApi = typeof import("../../mesh/thin-instance-gpu-culling.js");

/** Patch a standard-material Renderable for GPU frustum culling.
 *
 * Installs `_drawHook` on the mesh's ThinInstanceData and wraps `r.bind` so that
 * the compute cull pass runs before the draw call every frame. Replaces
 * `drawIndexed` with `drawIndexedIndirect` when visible instances are available. */
export function patchRenderableForCulling(r: Renderable, mesh: Mesh, scene: SceneContextInternal, cullApi: CullApi): void {
    const std = (r as any)._std as
        | {
              meshBindGroup: GPUBindGroup;
              shadowBindGroup: GPUBindGroup | null;
              receiveShadows: boolean;
              engine: EngineContextInternal;
              tiSync:
                  | ((
                        engine: EngineContextInternal,
                        ti: NonNullable<Mesh["thinInstances"]>,
                        pass: GPURenderPassEncoder | GPURenderBundleEncoder,
                        slot: number,
                        hasColor: boolean,
                        drawBuffers?: ThinInstanceDrawBuffers | null
                    ) => number)
                  | undefined;
              hasInstanceColor: boolean;
          }
        | undefined;
    if (!std || !mesh.thinInstances) {
        return;
    }

    const ti = mesh.thinInstances;
    const mi = mesh as MeshInternal;

    // Mark as direct (bypasses render bundles — needed for compute + indirect draw).
    (r as any)._direct = true;

    // Per-bind cull result (updated each frame by the patched update()).
    let _cullDrawBufs: ThinInstanceDrawBuffers | null = null;
    let _cullArgsBuffer: GPUBuffer | null = null;

    // Install draw hook. The standard draw function calls this when ti._drawHook is set.
    (ti as any)._drawHook = (pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number): number => {
        const g = mi._gpu;
        if (std.tiSync) {
            std.tiSync(std.engine, ti, pass, slot, std.hasInstanceColor, _cullDrawBufs);
        }
        pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
        pass.setBindGroup(1, std.meshBindGroup);
        if (std.receiveShadows && std.shadowBindGroup) {
            pass.setBindGroup(2, std.shadowBindGroup);
        }
        if (_cullArgsBuffer) {
            pass.drawIndexedIndirect(_cullArgsBuffer, 0);
        } else {
            pass.drawIndexed(g.indexCount, ti.count);
        }
        return 1;
    };

    // Wrap bind() to manage cull state lifetime and run the compute pass each frame.
    const origBind = r.bind.bind(r);
    r.bind = (eng, sig) => {
        const bound = origBind(eng, sig);
        const cullState = cullApi.createTiCullState();
        scene._meshDisposables.get(mesh)?.push(() => {
            cullApi.destroyTiCullState(cullState);
        });

        return {
            renderable: r,
            pipeline: bound.pipeline,
            update(ctx) {
                bound.update?.(ctx);
                const result = cullApi.prepareTiCull(std.engine, cullState, mesh, mi._gpu, ti, std.hasInstanceColor, ctx);
                _cullDrawBufs = result?.drawBuffers ?? null;
                _cullArgsBuffer = result?.argsBuffer ?? null;
            },
            draw: bound.draw,
        };
    };
}
