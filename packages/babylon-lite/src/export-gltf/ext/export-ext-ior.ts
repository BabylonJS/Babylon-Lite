/** KHR_materials_ior writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const iorWriter: MaterialExtensionWriter = {
    name: "KHR_materials_ior",
    write(ctx, material, out) {
        const ior = material._subsurface?.refraction?.indexOfRefraction;
        if (ior !== undefined && ior !== 1.5) {
            attachExtension(ctx, out, "KHR_materials_ior", { ior });
        }
    },
};
