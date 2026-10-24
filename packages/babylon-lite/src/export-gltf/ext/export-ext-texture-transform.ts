/** KHR_texture_transform on exported textureInfos. Inverts `gltf-ext-uv-transform.ts`, which copies
 *  glTF values onto the texture wrapper verbatim (`uAng` holds the glTF `rotation` angle unchanged). */

import type { ExportContext, SlotMapping } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfTextureInfo } from "../export-gltf-types.js";

const EXT = "KHR_texture_transform";

/** @internal Attach `KHR_texture_transform` to `info` when the slot's transform differs from identity.
 *  Components equal to their defaults are omitted; `texCoord` is written (when non-zero) only
 *  alongside another component. */
export function writeTextureTransform(ctx: ExportContext, info: GltfTextureInfo, mapping: SlotMapping): void {
    const t = mapping.transform;
    if (!t) {
        return;
    }
    const payload: Record<string, unknown> = {};
    if (t.offset[0] !== 0 || t.offset[1] !== 0) {
        payload.offset = [t.offset[0], t.offset[1]];
    }
    if (t.scale[0] !== 1 || t.scale[1] !== 1) {
        payload.scale = [t.scale[0], t.scale[1]];
    }
    if (t.rotation !== 0) {
        payload.rotation = t.rotation;
    }
    if (payload.offset === undefined && payload.scale === undefined && payload.rotation === undefined) {
        return;
    }
    if (mapping.texCoord !== 0) {
        payload.texCoord = mapping.texCoord;
    }
    attachExtension(ctx, info, EXT, payload);
}
