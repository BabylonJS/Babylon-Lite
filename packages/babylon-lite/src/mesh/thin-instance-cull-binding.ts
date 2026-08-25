/** Shared per-binding GPU frustum-culling lifecycle for thin-instanced renderables.
 *
 *  Dynamically imported only when a scene enables thin-instance GPU culling, and
 *  it statically pulls in the compute-cull module — so non-culling scenes fetch
 *  neither this helper nor `thin-instance-gpu-culling.ts`.
 *
 *  Factored here so Standard, PBR, and ShaderMaterial renderables share one
 *  implementation of the cull lifecycle instead of copy-pasting it three times.
 *  `tryBind` is the single seam a renderable's `bind()` calls: it does the
 *  opaque-only gate + per-mesh `_gpuCullingEnabled` check and creates the
 *  per-binding state. The renderable then reads
 *  `cullDrawBufs` for the compacted instance source and calls `binding.draw(...)`
 *  for the indirect-vs-fallback draw call. Keeping these few seams tiny is what
 *  lets non-culling scenes — which still fetch the per-material renderable
 *  chunks — stay within their bundle-size ceilings. */

import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene.js";
import type { DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { Mesh } from "./mesh.js";
import type { ThinInstanceData } from "./thin-instance.js";
import type { ThinInstanceDrawBuffers } from "./thin-instance-gpu.js";
import {
    createTiCullState,
    destroyTiCullState,
    getComputeDispatchBatch,
    prepareTiCull,
    publishTiLodBucket,
    type ComputeDispatchBatch,
    type ThinInstanceGpuCullState,
} from "./thin-instance-gpu-culling.js";

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
    /** @internal Shared task-local compute submission batch. */
    _updateBatch: ComputeDispatchBatch;
    /** Issue the indirect (culled) draw when visible instances were compacted, else a full instanced draw. */
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indexCount: number, instanceCount: number): void;
}

/** @internal Renderable augmented with its per-signature cull-state cache (see `tryBind`). */
type CullCachingRenderable = Renderable & { _tiCullStates?: WeakMap<RenderTargetSignature, ThinInstanceGpuCullState> };

/** Create a per-binding cull lifecycle for one thin-instanced renderable binding,
 *  iff the mesh opts in and is not excluded (transparent / transmissive — v1 is
 *  opaque-only). Returns undefined when culling does not apply, so the caller
 *  falls back to a normal instanced draw. Opaque culling
 *  stays bundle-compatible because its compacted buffers and indirect args are
 *  stable; cull-state transitions bump the bundle invalidation epoch.
 *
 *  The cull STATE (visible/args/params GPU buffers) is REUSED across re-binds: it
 *  is cached on the renderable, keyed by the pass's render-target signature.
 *  `buildBindings` re-binds every renderable on each `_renderableVersion` bump
 *  (i.e. on ANY geometry edit anywhere in the scene), so allocating a fresh state
 *  here each time both leaked the previous state's buffers (freed only on mesh
 *  dispose) AND churned Dawn's allocator by reallocating these buffers every edit
 *  — multi-MB per edit. Reusing keeps `ensureCullBuffers` a no-op when the
 *  instance capacity is unchanged. Keying by signature keeps a renderable drawn
 *  in several passes (e.g. main + shadow) on an independent cull state per pass.
 *  Each cached state is freed once, on mesh disposal. */
export function tryBind(
    renderable: Renderable,
    scene: SceneContext,
    mesh: Mesh,
    engine: EngineContext,
    hasColor: boolean,
    excluded: boolean,
    baseUpdate: ((context: DrawUpdateContext) => void) | undefined,
    signature: RenderTargetSignature
): TiCullBinding | undefined {
    const ti = mesh.thinInstances;
    if (!ti) {
        return undefined;
    }
    if (ti._lodSource) {
        if (excluded) {
            throw new Error("Thin-instance LOD partners require an opaque, non-transmissive material");
        }
        // The partner consumes buffers published by another renderable's update, so its vertex/indirect
        // handles must be resolved at draw time rather than captured in an opaque render bundle.
        (renderable as { _direct?: boolean })._direct = true;
        // This mesh is the LOD partner of a GPU-culled mesh: it consumes the far bucket that mesh's
        // culling compacts for this pass and never draws its own instance count (see bindLodPartner).
        return bindLodPartner(ti, signature, hasColor, baseUpdate);
    }
    if (excluded || !ti._gpuCullingEnabled) {
        return undefined;
    }
    const holder = renderable as CullCachingRenderable;
    const cache = (holder._tiCullStates ??= new WeakMap());
    let state = cache.get(signature);
    if (!state) {
        state = createTiCullState();
        cache.set(signature, state);
        const owned = state;
        scene._meshDisposables.get(mesh)?.push(() => {
            destroyTiCullState(owned);
        });
    } else {
        // The mesh geometry may have been resized since the last bind (resizeMeshGeometry bumps the renderable
        // version, which re-binds us); recompute the local bounding sphere so culling stays accurate.
        state._localSphereReady = false;
    }
    const updateBatch = getComputeDispatchBatch(signature);
    const binding: TiCullBinding = {
        cullDrawBufs: null,
        _args: null,
        _updateBatch: updateBatch,
        update(context: DrawUpdateContext): void {
            baseUpdate?.(context);
            const partner = ti._lodPartner ?? null;
            const res = prepareTiCull(engine, state, mesh, mesh._gpu, ti, hasColor, context, updateBatch, partner);
            binding.cullDrawBufs = res?.drawBuffers ?? null;
            binding._args = res?.argsBuffer ?? null;
            if (ti._lodBuckets) {
                publishTiLodBucket(ti, signature, res);
            }
        },
        draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indexCount: number, instanceCount: number): void {
            if (binding._args) {
                pass.drawIndexedIndirect(binding._args, 0);
            } else if (ti._drawArgsBuffer) {
                pass.drawIndexedIndirect(ti._drawArgsBuffer, 0);
            } else {
                pass.drawIndexed(indexCount, instanceCount);
            }
        },
    };
    return binding;
}

/** @internal Binding for the LOD partner of a GPU-culled mesh (`setThinInstanceLodPartner`). Its update
 *  looks up the far bucket the source mesh's culling published for this pass's signature; its draw issues
 *  ONLY that bucket's indirect draw — with no bucket (source not culling this pass, or culling fell back)
 *  it draws nothing, so the partner can never fall back to its own instance count and double-draw. */
function bindLodPartner(ti: ThinInstanceData, signature: RenderTargetSignature, hasColor: boolean, baseUpdate: ((context: DrawUpdateContext) => void) | undefined): TiCullBinding {
    const currentBucket = () => {
        const bucket = ti._lodBuckets?.get(signature);
        if (!bucket?.active) {
            return null;
        }
        if (hasColor && !bucket.colorBuffer) {
            throw new Error("Thin-instance LOD partner requires the source draw to provide instance colors");
        }
        return bucket;
    };
    const binding: TiCullBinding = {
        get cullDrawBufs() {
            return currentBucket();
        },
        get _args() {
            return currentBucket()?.argsBuffer ?? null;
        },
        _updateBatch: getComputeDispatchBatch(signature),
        update(context: DrawUpdateContext): void {
            baseUpdate?.(context);
        },
        draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, indexCount: number, instanceCount: number): void {
            const bucket = currentBucket();
            if (bucket) {
                pass.drawIndexedIndirect(bucket.argsBuffer, 0);
            } else if (!ti._lodSource) {
                if (ti._drawArgsBuffer) {
                    pass.drawIndexedIndirect(ti._drawArgsBuffer, 0);
                } else {
                    pass.drawIndexed(indexCount, instanceCount);
                }
            }
        },
    };
    return binding;
}
