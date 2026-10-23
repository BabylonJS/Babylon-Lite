/** KHR_materials_unlit writer (PBR path). Inverts `setPbrUnlit`. The unlit shader outputs
 *  `baseColor × _unlitColor`, where `baseColor` already includes the base color factor, so the
 *  tint multiplies the resolved factor's RGB. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const unlitWriter: MaterialExtensionWriter = (ctx, material, out) => {
    if (material._unlit !== true) {
        return;
    }
    attachExtension(ctx, out, "KHR_materials_unlit", {});
    const tint = material._unlitColor;
    if (!tint || (tint[0] === 1 && tint[1] === 1 && tint[2] === 1)) {
        return;
    }
    // Copied during capture: the callback runs after the readback await.
    const t = [tint[0], tint[1], tint[2]];
    ctx.afterResolve.push(() => {
        const pmr = (out.pbrMetallicRoughness ??= {});
        const f = pmr.baseColorFactor ?? [1, 1, 1, 1];
        const tinted = [f[0]! * t[0]!, f[1]! * t[1]!, f[2]! * t[2]!, f[3]!].map((v) => Math.min(Math.max(v, 0), 1));
        if (tinted[0] === 1 && tinted[1] === 1 && tinted[2] === 1 && tinted[3] === 1) {
            delete pmr.baseColorFactor;
        } else {
            pmr.baseColorFactor = tinted;
        }
    });
};
