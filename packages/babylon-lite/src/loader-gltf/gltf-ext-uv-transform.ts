/** KHR_texture_transform — per-texture UV transform.
 *
 *  Attaches `uScale/vScale/uOffset/vOffset/uAng` to the Texture2D wrapper
 *  returned by the loader when a textureInfo carries a KHR_texture_transform.
 *  Downstream the PBR material detects these fields and compiles a shader
 *  with per-texture `txfUV` wrapping. Identity transforms are skipped so the
 *  same cached Texture2D is reused without allocating a new wrapper.
 *
 *  Lazy-loaded: only pulled into bundles whose glTF declares
 *  `KHR_texture_transform` in `extensionsUsed`. */
import type { Texture2D } from "../texture/texture-2d.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { GltfFeature } from "./gltf-feature.js";

interface KtInfo {
    extensions?: {
        KHR_texture_transform?: {
            scale?: [number, number];
            offset?: [number, number];
            rotation?: number;
        };
    };
}

const ext: GltfFeature = {
    id: "KHR_texture_transform",
    wrapTexture(tex: Texture2D, texInfo: unknown): Texture2D {
        const kt = (texInfo as KtInfo | null | undefined)?.extensions?.KHR_texture_transform;
        if (!kt) {
            return tex;
        }
        const patch: { uScale?: number; vScale?: number; uOffset?: number; vOffset?: number; uAng?: number } = {};
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
        return Object.keys(patch).length ? cloneTexture2D(tex, patch) : tex;
    },
};
export default ext;
