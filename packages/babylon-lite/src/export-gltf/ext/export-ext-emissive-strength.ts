/** KHR_materials_emissive_strength writer. The core normalizes `emissiveFactor`; this only attaches the peak. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";

export const emissiveStrengthWriter: MaterialExtensionWriter = (ctx, material, out) => {
    const e = material._emissiveColor;
    if (!e) {
        return;
    }
    const m = Math.max(e[0], e[1], e[2]);
    if (m > 1) {
        attachExtension(ctx, out, "KHR_materials_emissive_strength", { emissiveStrength: m });
    }
};
