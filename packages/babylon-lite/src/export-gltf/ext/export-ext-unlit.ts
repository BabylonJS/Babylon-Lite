/** KHR_materials_unlit writer (PBR path). Inverts the loader's `setPbrUnlit`. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const unlitWriter: MaterialExtensionWriter = {
    name: "KHR_materials_unlit",
    write(ctx, material, out) {
        if (material._unlit !== true) {
            return;
        }
        attachExtension(ctx, out, "KHR_materials_unlit", {});
        const color = material._unlitColor;
        if (!color) {
            return;
        }
        ctx.afterResolve.push(() => {
            if (out.pbrMetallicRoughness?.baseColorFactor !== undefined) {
                return;
            }
            if (color[0] === 1 && color[1] === 1 && color[2] === 1) {
                return;
            }
            (out.pbrMetallicRoughness ??= {}).baseColorFactor = [color[0], color[1], color[2], 1];
        });
    },
};
