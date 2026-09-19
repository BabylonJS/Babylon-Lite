import type { ComputeDispatch } from "./compute-dispatch.js";

/** Mutate one retained dynamic-offset slot, allocating offset arrays only on first use. */
export function setComputeDispatchDynamicOffset(dispatch: ComputeDispatch, bindingName: string, byteOffset: number): void {
    const slot = dispatch.bindings._dynamicSlots?.get(bindingName);
    if (!slot) {
        throw new Error(`ComputeDispatch: binding "${bindingName}" is not a dynamic buffer binding.`);
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % slot._alignment !== 0) {
        throw new Error(`ComputeDispatch: dynamic offset for "${bindingName}" must be a non-negative multiple of ${slot._alignment}.`);
    }
    if (byteOffset > slot._maxOffset) {
        throw new Error(`ComputeDispatch: dynamic offset for "${bindingName}" exceeds the bound buffer range.`);
    }
    const offsets = (dispatch._dynamicOffsets ??= dispatch.shader._dynamicCounts.map((count) => new Array<number>(count).fill(0)));
    offsets[slot._group]![slot._index] = byteOffset;
}
