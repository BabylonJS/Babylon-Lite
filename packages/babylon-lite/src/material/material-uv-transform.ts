import type { Material } from "./material.js";
import { getMaterialSource } from "./material-view.js";

/** Return whether a material source has opted into per-texture UV transforms. */
export function hasMaterialUvTransform(material: Material): boolean {
    return (getMaterialSource(material) as Material & { readonly _hasUvTx?: boolean })._hasUvTx === true;
}
