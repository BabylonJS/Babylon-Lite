/** Opt-in per-sprite Float32 vec4 transport to a custom fragment's `in.instanceParams`. */
import type { Sprite2DLayer } from "./sprite-2d.js";
import { _markSprite2DDirty } from "./sprite-2d.js";
import { _appendSprite2DInstanceData } from "./sprite-2d-instance-layout.js";
import type { Sprite2DHandle } from "./sprite-2d-handle.js";
import { getSprite2DHandleIndex } from "./sprite-2d-handle.js";
import { wgsl } from "../shader/wgsl.js";

/** Four application-defined values, copied to owned Float32 storage by the setter. */
export type Sprite2DInstanceParams = readonly [number, number, number, number] | Float32Array;

/**
 * Enable per-instance parameters on a custom-shader layer. Existing and newly added sprites
 * start at zero. Idempotent; ordinary layers retain their layout until explicitly enabled.
 * The engine transports these values without interpreting them or changing color, UV or depth.
 * Enable depth-hosted layers before `addDepthHostedSpriteLayer`. Late enablement is supported
 * only by the pure-2D SpriteRenderer, which refreshes its pipeline each frame.
 */
export function enableSprite2DInstanceParams(layer: Sprite2DLayer): void {
    if (!layer.customShader) {
        throw new Error("enableSprite2DInstanceParams: layer requires a customShader.");
    }
    if (layer._vertexExtension) {
        if (layer._vertexExtension._owner === enableSprite2DInstanceParams) {
            return;
        }
        throw new Error("enableSprite2DInstanceParams: another instance extension is already installed.");
    }
    const offset = _appendSprite2DInstanceData(layer, 4);
    layer._vertexExtension = {
        _owner: enableSprite2DInstanceParams,
        _key: `:ip${offset}`,
        _shaderKey: "instance-params",
        _attribute: { shaderLocation: 8, offset: offset * 4, format: "float32x4" },
        _input: wgsl`,@location(8) instanceParams: vec4f`,
        _output: wgsl`@location(2) @interpolate(flat) instanceParams: vec4f,`,
        _assignment: wgsl`out.instanceParams = in.instanceParams;`,
        _initInstance(data, base) {
            data[base + offset] = 0;
            data[base + offset + 1] = 0;
            data[base + offset + 2] = 0;
            data[base + offset + 3] = 0;
        },
    };
}

/**
 * Copy four finite Float32 parameters to one live sprite. Requires explicit enablement.
 * Invalid input throws before any data or dirty state changes; valid calls allocate nothing.
 */
export function setSprite2DInstanceParamsIndex(layer: Sprite2DLayer, index: number, params: Sprite2DInstanceParams): void {
    const extension = layer._vertexExtension;
    if (extension?._owner !== enableSprite2DInstanceParams) {
        throw new Error("setSprite2DInstanceParamsIndex: enableSprite2DInstanceParams must be called first.");
    }
    if (!Number.isInteger(index) || index < 0 || index >= layer.count) {
        throw new Error(`setSprite2DInstanceParamsIndex: index ${index} out of range [0, ${layer.count})`);
    }
    if (!params || params.length !== 4) {
        throw new Error("setSprite2DInstanceParamsIndex: params must contain exactly four numbers.");
    }
    const x = params[0]!;
    const y = params[1]!;
    const z = params[2]!;
    const w = params[3]!;
    if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof z !== "number" ||
        typeof w !== "number" ||
        !Number.isFinite(Math.fround(x)) ||
        !Number.isFinite(Math.fround(y)) ||
        !Number.isFinite(Math.fround(z)) ||
        !Number.isFinite(Math.fround(w))
    ) {
        throw new Error("setSprite2DInstanceParamsIndex: params must be finite Float32 values.");
    }
    const base = index * layer._instanceFloatsPerSprite + extension._attribute.offset / 4;
    const data = layer._instanceData;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = z;
    data[base + 3] = w;
    _markSprite2DDirty(layer, index, index + 1);
}

/** Set parameters using a stable handle, resolving its current index after swap-removes. */
export function setSprite2DInstanceParams(handle: Sprite2DHandle, params: Sprite2DInstanceParams): void {
    setSprite2DInstanceParamsIndex(handle.layer, getSprite2DHandleIndex(handle), params);
}
