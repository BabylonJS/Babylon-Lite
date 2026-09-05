/**
 * Module: compute-pass
 *
 * The one place that records compute dispatches into a pass. Both the engine's
 * own compute (thin-instance GPU culling) and the user-facing seam
 * (`compute-shader`) go through here, so there is a single encoder/dispatch
 * path rather than one per caller.
 *
 * The recorded shape is deliberately minimal — a pipeline, a group-0 bind group
 * and a workgroup count — because that is all every caller has in common. The
 * pass dedups consecutive `setPipeline` calls, which is what makes running one
 * program over many binding sets cheap.
 */

/** @internal One recorded dispatch. `_y`/`_z` are omitted by callers that only ever dispatch in x. */
export interface RecordedDispatch {
    /** @internal */
    readonly _pipeline: GPUComputePipeline;
    /** @internal */
    readonly _bindGroup: GPUBindGroup;
    /** @internal */
    readonly _x: number;
    /** @internal */
    readonly _y?: number;
    /** @internal */
    readonly _z?: number;
}

/**
 * @internal Record `count` dispatches from `list` into one compute pass on `encoder`.
 *
 * `count` is passed separately so callers can keep a reusable array whose tail is
 * stale, which is how the per-frame culling batch avoids reallocating every frame.
 */
export function recordComputeDispatches(encoder: GPUCommandEncoder, list: readonly RecordedDispatch[], count: number): void {
    const pass = encoder.beginComputePass();
    let lastPipeline: GPUComputePipeline | null = null;
    for (let i = 0; i < count; i++) {
        const d = list[i]!;
        if (d._pipeline !== lastPipeline) {
            pass.setPipeline(d._pipeline);
            lastPipeline = d._pipeline;
        }
        pass.setBindGroup(0, d._bindGroup);
        // Called with the arity the caller actually supplied. WebGPU defaults y/z to 1,
        // but passing explicit `undefined` would change the call shape for the x-only
        // callers (the culling batch) for no gain.
        if (d._y === undefined) {
            pass.dispatchWorkgroups(d._x);
        } else {
            pass.dispatchWorkgroups(d._x, d._y, d._z);
        }
    }
    pass.end();
}
