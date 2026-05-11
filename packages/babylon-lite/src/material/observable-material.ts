/** Opt-in auto-dirty tracking for material properties.
 *
 *  Import and call `enableMaterialTracking(material)` to install property
 *  setters that automatically bump the source material UBO version on any mutation —
 *  including in-place array writes like `material.diffuseColor[0] = 0.5`.
 *
 *  The PBR and Standard tracking logic is dynamically imported so only the
 *  relevant code is bundled. Scenes using only PBR materials never pull in
 *  Standard tracking code, and vice versa. */

import type { Material, MaterialOrView } from "./material.js";
import { getMaterialSource } from "./material-view.js";

/** Enable automatic dirty tracking on a PBR or Standard material.
 *  After calling this, any UBO-backed property mutation marks the source material UBO dirty. */
export async function enableMaterialTracking(material: MaterialOrView & { specularPower?: unknown }): Promise<void> {
    const source = getMaterialSource(material) as Material & { specularPower?: unknown };
    if ("specularPower" in source) {
        const { installStdTracking } = await import("./tracking/std-tracking.js");
        installStdTracking(source as any);
    } else {
        const { installPbrTracking } = await import("./tracking/pbr-tracking.js");
        installPbrTracking(source as any);
    }
}
