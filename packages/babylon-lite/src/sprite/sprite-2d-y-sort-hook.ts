/** Null-by-default seam for the optional Sprite2D GPU-order extension. */
import type { Sprite2DLayer } from "./sprite-2d.js";

/** @internal Opaque hooks implemented by the opt-in Sprite2D Y-sort module. */
export interface Sprite2DYSortHook {
    /** Observe a newly appended logical slot. */
    readonly add: (layer: Sprite2DLayer, index: number) => void;
    /** Observe a completed canonical swap-remove. */
    readonly remove: (layer: Sprite2DLayer, index: number, last: number) => void;
    /** Observe a completed clear, including the previous live count. */
    readonly clear: (layer: Sprite2DLayer, previousCount: number) => void;
    /** Observe canonical writes after the supplied logical range is dirty. */
    readonly dirty: (layer: Sprite2DLayer, lo: number, hi: number) => void;
    /** Upload an optional GPU-order representation, or return `undefined` for canonical upload. */
    readonly upload: (device: GPUDevice, layer: Sprite2DLayer, instanceBuffer: GPUBuffer, uploadedVersion: number) => number | undefined;
    /** Return draw-slot to logical-slot order, or `null` for canonical order. */
    readonly drawOrder: (layer: Sprite2DLayer) => Uint32Array | null;
}

let _sprite2DYSortHook: Sprite2DYSortHook | null = null;

/** @internal Install the optional Sprite2D GPU-order hook. */
export function _registerSprite2DYSortHook(hook: Sprite2DYSortHook): void {
    _sprite2DYSortHook = hook;
}

/** @internal Return the optional Sprite2D GPU-order hook. */
export function _getSprite2DYSortHook(): Sprite2DYSortHook | null {
    return _sprite2DYSortHook;
}
