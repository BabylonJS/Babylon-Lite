import { F32 } from "../engine/typed-arrays.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { _markSprite2DDirty } from "./sprite-2d.js";

/** @internal Append zeroed fields to every instance record; return their float offset. */
export function _appendSprite2DInstanceData(layer: Sprite2DLayer, extraFloats: number): number {
    const oldStride = layer._instanceFloatsPerSprite;
    const newStride = oldStride + extraFloats;
    const next = new F32(layer._capacity * newStride);
    for (let index = 0; index < layer.count; index++) {
        const oldBase = index * oldStride;
        const newBase = index * newStride;
        for (let component = 0; component < oldStride; component++) {
            next[newBase + component] = layer._instanceData[oldBase + component]!;
        }
    }
    layer._instanceData = next;
    layer._instanceFloatsPerSprite = newStride;
    layer._instanceStrideBytes = newStride * 4;
    _markSprite2DDirty(layer, 0, layer.count);
    return oldStride;
}
