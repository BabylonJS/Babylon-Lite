/** UV-transform PbrExt. Registered lazily only when a scene actually has a
 *  material with PBR2_HAS_UV_TRANSFORM set, so non-UV-transform bundles pay
 *  zero bytes. Template-only ext — contributes no fragment or bindings, just
 *  a material-UBO slice. */

import type { Texture2D } from "../../../texture/texture-2d.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";

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
        data[mi + 1] = -s * sy;
        data[mi + 2] = s * sx;
        data[mi + 3] = c * sy;
    }
    data[ti] = ox;
    data[ti + 1] = oy;
    data[ti + 2] = 0;
    data[ti + 3] = 0;
}

export const uvTransformExt: PbrExt = {
    id: "uv-transform",
    phase: "fragment",
    writeUbo(data: Float32Array, material: unknown, offsets: ReadonlyMap<string, number>): void {
        const m = material as PbrMaterialProps;
        writeOne(data, offsets, "baseColor", m.baseColorTexture);
        writeOne(data, offsets, "normal", m.normalTexture);
        writeOne(data, offsets, "orm", m.ormTexture);
        writeOne(data, offsets, "emissive", m.emissiveTexture);
        writeOne(data, offsets, "specGloss", m.specGlossTexture);
    },
};
