import type { Material } from "./material.js";
import { getMaterialSource } from "./material-view.js";

/** Mark a material source (or one of its views) as needing UBO re-upload.
 *  The source owns a monotonic version so multiple renderables/views can observe
 *  the same mutation independently without racing on a single cleared boolean. */
export function markMaterialUboDirty(materialOrView: Material): void {
    const source = getMaterialSource(materialOrView);
    source._uboVersion++;
}
