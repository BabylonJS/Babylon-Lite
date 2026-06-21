/** KHR_animation_pointer glTF feature.
 *
 *  Registered in the feature registry gated on `KHR_animation_pointer`, so any
 *  scene that doesn't declare the extension pays zero bytes for pointer
 *  resolution, the non-Float32 sampler converter, or the visibility cascade.
 *
 *  On side-effect import this module installs two callbacks into gltf-animation:
 *   1. A pointer-channel parser (resolves the JSON pointer to a writer fn).
 *   2. A sampler converter that handles the non-Float32/misaligned accessor
 *      cases the fast path in gltf-animation can't express (e.g. the 11-byte
 *      UNSIGNED_BYTE visibility accessor in CubeVisibility.glb).
 *
 *  Node-visibility and node-TRS pointers resolve here directly. Material
 *  pointer targets (texture-transform offset/scale/rotation, factors, …) are
 *  resolved by `resolveAnimationPointer` in animation-pointer.ts, invoked from
 *  the pointer-channel parser installed below. */

import { F32, U16, I16, U8, I8 } from "../engine/typed-arrays.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { TargetPath } from "../animation/types.js";
import { PATH_POINTER, PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS } from "../animation/types.js";
import { setSubtreeVisible } from "../scene/visibility.js";
import { _installPointerHandlers } from "./gltf-animation.js";

// Node TRS/weights pointer targets map 1:1 onto the standard glTF channel paths.
const NODE_TRS_PATH: Record<string, TargetPath> = {
    translation: PATH_TRANSLATION,
    rotation: PATH_ROTATION,
    scale: PATH_SCALE,
    weights: PATH_WEIGHTS,
};

_installPointerHandlers(
    (ptr, c, nodeMap) => {
        if (!nodeMap) {
            return null;
        }
        // A /nodes/{n}/{translation|rotation|scale|weights} pointer is semantically
        // identical to a standard glTF channel on node n. Emit a standard channel so it
        // flows through the proven topological node-TRS / morph writeback (which moves the
        // node AND its descendants) instead of an opaque per-node writer.
        const trs = /^\/nodes\/(\d+)\/(translation|rotation|scale|weights)$/.exec(ptr);
        if (trs) {
            return { samplerIdx: c.sampler, nodeIdx: +trs[1]!, path: NODE_TRS_PATH[trs[2]!]! };
        }
        // KHR_node_visibility pointer — toggles the node's subtree visibility. Handled
        // inline (not via the material registry) so node-only pointer assets never bundle
        // the material pointer code.
        const vis = /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/.exec(ptr);
        if (vis) {
            const n = nodeMap[+vis[1]!];
            if (!n) {
                return null;
            }
            return {
                samplerIdx: c.sampler,
                nodeIdx: -1,
                path: PATH_POINTER,
                pointerWriter: (out, off) => setSubtreeVisible(n, out[off]! !== 0),
                pointerArity: 1,
            };
        }
        // Material pointers (`/materials/...`) are resolved by the lazily-loaded
        // gltf-pointer-material feature via gltf-animation's material resolver seam.
        return null;
    },
    (src, length, normalized) => {
        // Convert any animation-sampler payload to a standalone Float32Array.
        // Handles the cases the aligned-Float32 fast path can't express.
        const out = new F32(length);
        if (src instanceof F32) {
            for (let i = 0; i < length; i++) {
                out[i] = src[i]!;
            }
        } else if (src instanceof U8) {
            const k = normalized ? 1 / 255 : 1;
            for (let i = 0; i < length; i++) {
                out[i] = src[i]! * k;
            }
        } else if (src instanceof U16) {
            const k = normalized ? 1 / 65535 : 1;
            for (let i = 0; i < length; i++) {
                out[i] = src[i]! * k;
            }
        } else if (src instanceof I8) {
            for (let i = 0; i < length; i++) {
                out[i] = normalized ? Math.max(src[i]! / 127, -1) : src[i]!;
            }
        } else if (src instanceof I16) {
            for (let i = 0; i < length; i++) {
                out[i] = normalized ? Math.max(src[i]! / 32767, -1) : src[i]!;
            }
        }
        return out;
    }
);

const feature: GltfFeature = { id: "KHR_animation_pointer" };
export default feature;
