/** KHR_materials_dispersion writer. Inverts the loader's `20 / dispersion`. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const dispersionWriter: MaterialExtensionWriter = {
    name: "KHR_materials_dispersion",
    write(ctx, material, out) {
        const ss = material._subsurface;
        const r = ss?.refraction;
        if (r !== undefined && ss?.thickness !== undefined && (r.dispersion ?? 0) > 0) {
            attachExtension(ctx, out, "KHR_materials_dispersion", { dispersion: 20 / (r.dispersion as number) });
        }
    },
};
