/**
 * Opt-in per-sprite UV-scroll feature for `Sprite2DLayer` (parallax / infinite-scroll backgrounds).
 *
 * Importing `setSprite2DUvOffset` is the trigger that pulls this module — and with it the lazy
 * narrow→wide re-stride that adds two `uvOffset.xy` floats per sprite — into the bundle. Sprite
 * scenes that never call the setter keep every layer narrow (`_uvScrollAttr` absent), so they ship
 * none of the re-stride or attribute-building code.
 *
 * The always-loaded pipeline needs no *code* from this module: the re-stride precomputes the
 * `@location(7)` vertex attribute and stashes it on the layer as plain data (`_uvScrollAttr`), so
 * the pipeline just pushes that data — the attribute-building lives here, not in the always-loaded
 * path. The widened stride is likewise already on the layer (`_instanceStrideBytes`), and the shader
 * widening (`+ in.iUvOffset`) is gated on `_uvScrollAttr` presence in the shared sprite prologue. So
 * the *only* code that has to be opt-in is the data-side widening below — no hook indirection needed
 * (unlike coverage gamma, whose fragment permutation and per-frame UBO write must stay opt-in).
 *
 * Unlike the create-time option it replaces, scroll is enabled **lazily on the first call**: the
 * layer is created and populated with the narrow layout, then the first `setSprite2DUvOffset`
 * widens the existing sprites in place (an O(count) re-stride) and flips it to the wide layout.
 * Calling it during setup (right after the first adds) is cheapest; calling it later is also safe —
 * the renderer reallocates the GPU instance buffer (its byte size grew) and re-uploads next frame.
 */
import { F32 } from "../engine/typed-arrays.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { DEPTH_INSTANCE_FLOATS_PER_SPRITE, PURE_2D_INSTANCE_FLOATS_PER_SPRITE, _markSprite2DDirty } from "./sprite-2d.js";

/** Extra floats appended per sprite when uvScroll is enabled: `uvOffset.xy`. */
const UVSCROLL_EXTRA_FLOATS_PER_SPRITE = 2;

/** Base (narrow) per-sprite float stride for the given depth mode. */
function baseFloats(hasDepth: boolean): number {
    return hasDepth ? DEPTH_INSTANCE_FLOATS_PER_SPRITE : PURE_2D_INSTANCE_FLOATS_PER_SPRITE;
}

/**
 * Widen `layer` from the narrow base layout to the wide (uvOffset) layout, re-striding any existing
 * sprites into a freshly allocated buffer (uvOffset slots default `[0, 0]`). No-op if already wide.
 */
function ensureWide(layer: Sprite2DLayer): void {
    if (layer._uvScrollAttr) {
        return;
    }
    const oldStride = layer._instanceFloatsPerSprite;
    const newStride = oldStride + UVSCROLL_EXTRA_FLOATS_PER_SPRITE;
    const next = new F32(layer._capacity * newStride);
    for (let i = 0; i < layer.count; i++) {
        next.set(layer._instanceData.subarray(i * oldStride, i * oldStride + oldStride), i * newStride);
    }
    layer._instanceData = next;
    (layer as { _instanceFloatsPerSprite: number })._instanceFloatsPerSprite = newStride;
    (layer as { _instanceStrideBytes: number })._instanceStrideBytes = newStride * 4;
    // Precompute the `uvOffset.xy` vertex attribute here (in the opt-in module) and stash it on the
    // layer as plain data. The always-loaded pipeline just pushes it — so the attribute-building code
    // never ships to non-scroll scenes. uvOffset sits right after the base layout, so its byte offset
    // equals the *narrow* stride: 52 (pure-2D) / 56 (depth-hosted).
    (layer as { _uvScrollAttr?: GPUVertexAttribute })._uvScrollAttr = { shaderLocation: 7, offset: oldStride * 4, format: "float32x2" };
    // The stride change invalidates the entire GPU buffer; force a full re-upload. The renderer
    // also reallocates the instance buffer next frame because its required byte size grew.
    layer._dirtyMin = 0;
    layer._dirtyMax = layer.count;
    layer._version = (layer._version + 1) | 0;
}

/**
 * Set (and enable) the per-sprite UV scroll offset for one sprite of `layer`. The two floats are
 * added to the sprite's sampled UV in the vertex stage — driving parallax / infinite-scroll
 * backgrounds without re-uploading texture coordinates.
 *
 * **Opt-in & tree-shakable:** importing this function is what pulls the uvScroll widening into the
 * bundle. The **first** call on a layer enables scroll: it widens the layer's instance layout by
 * two floats per sprite (re-striding existing sprites once) and flips it to the wide layout;
 * subsequent calls just write the offset. There is no create-time option — a layer is always
 * created narrow and opts into scroll the first time this setter is used.
 *
 * @param layer - The sprite layer to scroll.
 * @param index - Index of the sprite within the layer.
 * @param uvOffset - The UV offset `[u, v]` added to the sprite's sampled UV.
 */
export function setSprite2DUvOffset(layer: Sprite2DLayer, index: number, uvOffset: readonly [number, number]): void {
    if (index < 0 || index >= layer.count) {
        throw new Error(`setSprite2DUvOffset: index ${index} out of range [0, ${layer.count})`);
    }
    ensureWide(layer);
    const base = index * layer._instanceFloatsPerSprite;
    const uvSlot = base + baseFloats(layer.depth !== "none");
    layer._instanceData[uvSlot] = uvOffset[0];
    layer._instanceData[uvSlot + 1] = uvOffset[1];
    _markSprite2DDirty(layer, index, index + 1);
}
