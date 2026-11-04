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
 * Calling it during setup (right after the first adds) is cheapest. Pure-2D SpriteRenderer layers
 * also support late enablement: the renderer replaces the buffer and pipeline next frame.
 * Depth-hosted layers must enable before `addDepthHostedSpriteLayer`, whose bindings cache pipelines.
 */
import type { Sprite2DLayer } from "./sprite-2d.js";
import { _markSprite2DDirty } from "./sprite-2d.js";
import { _appendSprite2DInstanceData } from "./sprite-2d-instance-layout.js";

/** Extra floats appended per sprite when uvScroll is enabled: `uvOffset.xy`. */
const UVSCROLL_EXTRA_FLOATS_PER_SPRITE = 2;

/**
 * Widen `layer` from the narrow base layout to the wide (uvOffset) layout, re-striding any existing
 * sprites into a freshly allocated buffer (uvOffset slots default `[0, 0]`). No-op if already wide.
 */
function ensureWide(layer: Sprite2DLayer): void {
    if (layer._uvScrollAttr) {
        return;
    }
    const oldStride = _appendSprite2DInstanceData(layer, UVSCROLL_EXTRA_FLOATS_PER_SPRITE);
    // Precompute the `uvOffset.xy` vertex attribute here (in the opt-in module) and stash it on the
    // layer as plain data. The always-loaded pipeline just pushes it — so the attribute-building code
    // never ships to non-scroll scenes. Append after any already-enabled instance extension.
    layer._uvScrollAttr = { shaderLocation: 7, offset: oldStride * 4, format: "float32x2" };
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
 * For depth-hosted layers, make the first call before `addDepthHostedSpriteLayer`.
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
    const uvSlot = base + layer._uvScrollAttr!.offset / 4;
    layer._instanceData[uvSlot] = uvOffset[0];
    layer._instanceData[uvSlot + 1] = uvOffset[1];
    _markSprite2DDirty(layer, index, index + 1);
}
