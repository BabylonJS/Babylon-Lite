/** KHR_animation_pointer glTF feature.
 *
 *  Registered in load-gltf.ts's feature table gated on
 *  `extensionsUsed.includes("KHR_animation_pointer")`, so any scene that
 *  doesn't declare the extension pays zero bytes for pointer resolution, the
 *  non-Float32 sampler converter, or the visibility cascade helper.
 *
 *  On side-effect import this module installs two callbacks into gltf-animation:
 *   1. A pointer-channel parser (resolves the JSON pointer to a writer fn).
 *   2. A sampler converter that handles the non-Float32/misaligned accessor
 *      cases the fast path in gltf-animation can't express (e.g. the 11-byte
 *      UNSIGNED_BYTE visibility accessor in CubeVisibility.glb). */

import type { GltfFeature } from "./gltf-feature.js";
import type { AnimationChannel } from "../animation/types.js";
import { PATH_POINTER } from "../animation/types.js";
import { resolveAnimationPointer } from "./animation-pointer.js";
import { _installPointerHandlers } from "./gltf-animation.js";

_installPointerHandlers(
    (ptr, c, nodeMap) => {
        if (!nodeMap) {
            return null;
        }
        const resolved = resolveAnimationPointer(ptr, { nodes: nodeMap });
        if (!resolved) {
            return null;
        }
        const ch: AnimationChannel = {
            samplerIdx: c.sampler,
            nodeIdx: -1,
            path: PATH_POINTER,
            pointerWriter: resolved.writer,
            pointerArity: resolved.arity,
        };
        return ch;
    },
    (src, length, normalized) => {
        // Convert any animation-sampler payload to a standalone Float32Array.
        // Handles the cases the aligned-Float32 fast path can't express.
        const out = new Float32Array(length);
        if (src instanceof Float32Array) {
            for (let i = 0; i < length; i++) {
                out[i] = src[i]!;
            }
        } else if (src instanceof Uint8Array) {
            const k = normalized ? 1 / 255 : 1;
            for (let i = 0; i < length; i++) {
                out[i] = src[i]! * k;
            }
        } else if (src instanceof Uint16Array) {
            const k = normalized ? 1 / 65535 : 1;
            for (let i = 0; i < length; i++) {
                out[i] = src[i]! * k;
            }
        } else if (src instanceof Int8Array) {
            for (let i = 0; i < length; i++) {
                out[i] = normalized ? Math.max(src[i]! / 127, -1) : src[i]!;
            }
        } else if (src instanceof Int16Array) {
            for (let i = 0; i < length; i++) {
                out[i] = normalized ? Math.max(src[i]! / 32767, -1) : src[i]!;
            }
        }
        return out;
    }
);

// No per-asset hook — this feature only installs the seam at import time.
const feature: GltfFeature = { id: "KHR_animation_pointer" };
export default feature;
