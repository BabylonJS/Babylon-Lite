/** KHR_materials_ior writer. The IOR comes from the refraction props; without one, a dielectric
 *  `reflectance` other than the 0.04 default (Lite's F0) is expressed as the equivalent IOR,
 *  `F0 = ((ior − 1) / (ior + 1))²`. Spec-gloss materials take F0 from their texture instead. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const iorWriter: MaterialExtensionWriter = {
    name: "KHR_materials_ior",
    write(ctx, material, out) {
        let ior = material._subsurface?.refraction?.indexOfRefraction;
        const reflectance = material.reflectance;
        if (ior === undefined && reflectance !== undefined && reflectance !== 0.04 && !material.specGlossTexture) {
            const r = Math.sqrt(Math.min(Math.max(reflectance, 0), 0.99));
            ior = (1 + r) / (1 - r);
        }
        if (ior !== undefined && Math.abs(ior - 1.5) > 1e-9) {
            attachExtension(ctx, out, "KHR_materials_ior", { ior });
        }
    },
};
