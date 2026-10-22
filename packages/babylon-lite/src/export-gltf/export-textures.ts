/** Texture export: the capture/resolve funnel every material slot goes through. */

import type { Texture2D } from "../texture/texture-2d.js";
import type { ExportContext, PendingSlot, SlotMapping } from "./export-context.js";
import type { GltfJsonObject, GltfTextureInfo } from "./export-gltf-types.js";
import { checkTextureReadable, insertImage, requestPixels } from "./export-images.js";
import { writeTextureTransform } from "./ext/export-ext-texture-transform.js";

/** @internal Capture one material slot (synchronous). Records a pending slot and submits the
 *  texture's readback unless one is already in flight. An unreadable texture logs its warning and
 *  records nothing. Writes nothing to `owner`; {@link resolveTextureSlots} does. */
export function captureTextureSlot(
    ctx: ExportContext,
    owner: GltfJsonObject,
    key: string,
    slot: string,
    tex: Texture2D,
    mapping: SlotMapping,
    materialName: string,
    extra?: Readonly<Record<string, number>>
): PendingSlot | null {
    if (!checkTextureReadable(ctx, tex, materialName)) {
        return null;
    }
    void requestPixels(ctx, tex);
    // Reserve the member's position so the JSON key order follows capture order; an unresolved
    // slot stays undefined and JSON.stringify omits it.
    if (!(key in owner)) {
        owner[key] = undefined;
    }
    const pending: PendingSlot = { owner, key, slot, gpu: tex.texture, mapping, extra, materialName };
    ctx.slots.push(pending);
    return pending;
}

/** @internal Resolve every captured slot, in capture order, after all readbacks have settled
 *  (synchronous). Image and texture indices are assigned here, so they never depend on GPU
 *  completion order. */
export function resolveTextureSlots(ctx: ExportContext): void {
    const imagesByTexture = new Map<GPUTexture, Map<string, number>>();
    for (const slot of ctx.slots) {
        if (slot.cancelled) {
            continue;
        }
        const pixels = ctx.resolvedPixels.get(slot.gpu);
        if (!pixels) {
            continue;
        }
        const variant = `${slot.mapping.rowOrder}:${slot.mapping.invert ?? ""}:${slot.mapping.colorDecode ?? ""}`;
        let byVariant = imagesByTexture.get(slot.gpu);
        let image = byVariant?.get(variant);
        if (image === undefined) {
            image = insertImage(ctx, pixels, slot.mapping, slot.slot);
            if (!byVariant) {
                byVariant = new Map();
                imagesByTexture.set(slot.gpu, byVariant);
            }
            byVariant.set(variant, image);
        }
        let index = ctx.textureIndex.get(image);
        if (index === undefined) {
            index = ctx.doc.textures.push({ source: image }) - 1;
            ctx.textureIndex.set(image, index);
        }
        const info: GltfTextureInfo = { index };
        if (slot.mapping.texCoord === 1) {
            info.texCoord = 1;
        }
        if (slot.extra) {
            Object.assign(info, slot.extra);
        }
        writeTextureTransform(ctx, info, slot.mapping);
        slot.owner[slot.key] = info;
    }
}
