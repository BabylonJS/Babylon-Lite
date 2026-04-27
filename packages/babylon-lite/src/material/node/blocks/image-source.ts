/** ImageSourceBlock — holds a texture reference and feeds a TextureBlock's `source` input.
 *
 *  The emitter does not emit any WGSL of its own; it just advertises that a
 *  texture binding named after this block exists, so the downstream TextureBlock
 *  can refer to it. The actual texture upload is handled at material-build time.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ImageSourceBlock",
    emit(block, _outputName, _stage, state, _ctx) {
        const bindingName = sanitize(block.name || `img${block.id}`);
        if (!state.textures.find((t) => t.name === bindingName)) {
            state.textures.push({ name: bindingName, kind: "texture2d", texture: null });
        }
        // Return a sentinel — the TextureBlock consumes the binding name via this.
        return { expr: bindingName, type: "texture2d" };
    },
};

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
