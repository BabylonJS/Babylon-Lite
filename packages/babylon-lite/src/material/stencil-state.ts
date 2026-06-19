import type { StencilState } from "./material.js";

/**
 * @internal
 * Baked stencil pieces for a material: a partial depth-stencil descriptor (front and back share one ops
 * object) plus a pipeline-cache-key suffix that distinguishes this stencil configuration so two materials
 * differing only in stencil never share a baked pipeline.
 */
export interface ResolvedStencil {
    /** @internal Partial `GPUDepthStencilState` carrying only the stencil sub-fields. */
    readonly _desc: Partial<GPUDepthStencilState>;
    /** @internal Cache-key suffix folded into pipeline keys. */
    readonly _key: string;
}

/**
 * @internal
 * Bake a material's {@link StencilState} into a {@link ResolvedStencil}. Lives in its own module so the
 * object-literal construction and default-filling never land in the always-fetched pipeline graph — it is
 * reachable only after `enableMaterialStencil()` installs it into the per-pipeline resolver hooks.
 */
export function _resolveStencil(stencil: StencilState): ResolvedStencil {
    const op: GPUStencilFaceState = {
        compare: stencil.compare ?? "always",
        passOp: stencil.passOp ?? "keep",
        failOp: stencil.failOp ?? "keep",
        depthFailOp: stencil.depthFailOp ?? "keep",
    };
    const readMask = stencil.readMask ?? 0xff;
    const writeMask = stencil.writeMask ?? 0xff;
    return {
        // Front and back share the same ops object — GPUStencilFaceState is read by value at pipeline creation.
        _desc: { stencilFront: op, stencilBack: op, stencilReadMask: readMask, stencilWriteMask: writeMask },
        _key: `st:${op.compare}:${op.passOp}:${op.failOp}:${op.depthFailOp}:${readMask}:${writeMask}`,
    };
}
