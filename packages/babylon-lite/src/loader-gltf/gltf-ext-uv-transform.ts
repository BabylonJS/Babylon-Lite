/** Per-textureInfo UV customization: KHR_texture_transform and/or texCoord=1.
 *
 *  - Attaches `uScale/vScale/uOffset/vOffset/uAng` + `_hasTx=true` when the
 *    textureInfo carries a KHR_texture_transform.
 *  - Attaches `_texCoord=1` when the textureInfo (or its transform extension)
 *    selects UV set 1. Spec: KHR_texture_transform.texCoord overrides
 *    textureInfo.texCoord.
 *
 *  Downstream the PBR material detects these fields and compiles a shader
 *  with per-texture `txfUV` wrapping and per-texture UV selection. Identity
 *  (no transform, texCoord=0) returns the base texture unchanged so the
 *  cache reuses the same wrapper.
 *
 *  Lazy-loaded: pulled into bundles whose glTF declares KHR_texture_transform
 *  in `extensionsUsed` OR uses `texCoord:1` on any textureInfo. */
import type { Texture2D } from "../texture/texture-2d.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { GltfFeature } from "./gltf-feature.js";

interface KtInfo {
    texCoord?: number;
    extensions?: {
        KHR_texture_transform?: {
            scale?: [number, number];
            offset?: [number, number];
            rotation?: number;
            texCoord?: number;
        };
    };
}

const ext: GltfFeature = {
    id: "KHR_texture_transform",
    wrapTexture(tex: Texture2D, texInfo: unknown): Texture2D {
        const info = texInfo as KtInfo | null | undefined;
        if (!info) {
            return tex;
        }
        const kt = info.extensions?.KHR_texture_transform;
        const patch: { uScale?: number; vScale?: number; uOffset?: number; vOffset?: number; uAng?: number; _hasTx?: true; _texCoord?: 0 | 1 } = {};
        if (kt) {
            if (kt.scale) {
                patch.uScale = kt.scale[0];
                patch.vScale = kt.scale[1];
            }
            if (kt.offset) {
                patch.uOffset = kt.offset[0];
                patch.vOffset = kt.offset[1];
            }
            if (kt.rotation) {
                patch.uAng = kt.rotation;
            }
            if (Object.keys(patch).length) {
                patch._hasTx = true;
            }
        }
        // Spec: KHR_texture_transform.texCoord overrides textureInfo.texCoord.
        const tc = kt?.texCoord ?? info.texCoord;
        if (tc === 1) {
            patch._texCoord = 1;
        }
        return Object.keys(patch).length ? cloneTexture2D(tex, patch) : tex;
    },
};
export default ext;
