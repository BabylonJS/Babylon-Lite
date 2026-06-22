/** UV-transform PbrExt. Registered lazily only when a scene actually has a
 *  material with PBR2_HAS_UV_TRANSFORM set, so non-UV-transform bundles pay
 *  zero bytes. Template-only ext — contributes no fragment or bindings, just
 *  a material-UBO slice. */

import type { Texture2D } from "../../../texture/texture-2d.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";

// Independent-occlusion UV transform (orm-unpack) features2 bit. Defined here,
// not in the shared flag module, for zero bundle movement on scenes that never
// load this lazy fragment. Reserved as 1<<28 in pbr-flag-bits.ts. Set when a
// material samples occlusion from the ORM texture with its OWN UV transform
// (occlusionTexture carrier present and NOT on UV2), so the shader emits a
// second ORM sample at occlUV. Read by the lazy pbr-template-ext only.
const PBR2_OCCL_UV_SPLIT = 1 << 28;

function writeOne(data: Float32Array, offsets: ReadonlyMap<string, number>, texName: string, tex: Texture2D | null | undefined): void {
    const mOff = offsets.get(`${texName}UVm`);
    const tOff = offsets.get(`${texName}UVt`);
    if (mOff === undefined || tOff === undefined) {
        return;
    }
    const mi = mOff / 4;
    const ti = tOff / 4;
    const sx = tex?.uScale ?? 1;
    const sy = tex?.vScale ?? 1;
    const ang = tex?.uAng ?? 0;
    const ox = tex?.uOffset ?? 0;
    const oy = tex?.vOffset ?? 0;
    if (ang === 0) {
        data[mi] = sx;
        data[mi + 1] = 0;
        data[mi + 2] = 0;
        data[mi + 3] = sy;
    } else {
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        data[mi] = c * sx;
        data[mi + 1] = s * sy;
        data[mi + 2] = -s * sx;
        data[mi + 3] = c * sy;
    }
    data[ti] = ox;
    data[ti + 1] = oy;
    data[ti + 2] = 0;
    data[ti + 3] = 0;
}

export const pbrExt: PbrExt = {
    id: "uv-transform",
    phase: "fragment",
    detect(mat: unknown): { f: number; f2: number } {
        const m = mat as PbrMaterialProps;
        // Occlusion carries its own UV transform (sampled from the ORM texture at a
        // distinct UV) when an occlusionTexture carrier exists and it is NOT a UV2
        // occlusion (texCoord 1 uses input.uv2 instead).
        const split = !!m.occlusionTexture && !m.occlusionTexCoord;
        return { f: 0, f2: split ? PBR2_OCCL_UV_SPLIT : 0 };
    },
    writeUbo(data: Float32Array, material: unknown, offsets: ReadonlyMap<string, number>): void {
        const m = material as PbrMaterialProps;
        writeOne(data, offsets, "baseColor", m.baseColorTexture);
        writeOne(data, offsets, "normal", m.normalTexture);
        writeOne(data, offsets, "orm", m.ormTexture);
        writeOne(data, offsets, "emissive", m.emissiveTexture);
        writeOne(data, offsets, "specGloss", m.specGlossTexture);
        writeOne(data, offsets, "occl", m.occlusionTexture);
    },
};
