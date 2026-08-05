/** Lazily-installed animation-sampler converter for non-Float32 / normalized accessor payloads:
 *  normalized signed BYTE/SHORT rotation output (glTF-Asset-Generator Animation_SamplerType),
 *  normalized UNSIGNED_BYTE flags, misaligned Float32, etc. Imported for side effect only when an
 *  animation sampler is non-float (registry trigger) or by KHR_animation_pointer, so plain
 *  float-sampler animations never bundle this denormalization code and stay byte-identical. */
import { F32, U8, I8, I16 } from "../engine/typed-arrays.js";
import type { GltfFeature } from "./gltf-feature.js";
import { _installSamplerConverter } from "./gltf-animation.js";

_installSamplerConverter((src, length, normalized) => {
    // Aligned Float32 fast path (also covers the misaligned-reinterpret case the default handled).
    if (src instanceof F32) {
        return new F32(src.buffer, src.byteOffset, length);
    }
    const out = new F32(length);
    const div = src instanceof I8 ? 127 : src instanceof I16 ? 32767 : src instanceof U8 ? 255 : 65535;
    const signed = src instanceof I8 || src instanceof I16;
    const s = src as unknown as { [i: number]: number };
    for (let i = 0; i < length; i++) {
        out[i] = normalized ? (signed ? Math.max(s[i]! / div, -1) : s[i]! / div) : s[i]!;
    }
    return out;
});

// Hookless feature: registered in the registry so loadGltfFeatures imports this module (installing
// the converter above as a side effect). The empty default keeps `mods.map(m => m.default)` valid.
const feature: GltfFeature = { id: "_sampler_denorm" };
export default feature;
