/**
 * Legacy combined shadow fragment entry.
 *
 * Material receivers dynamically load `shadow-fragment-builder` so they retain
 * only the algorithms prepared for their scene. This entry preserves the existing
 * synchronous internal API for direct callers that explicitly import it.
 */

import type { ShaderFragment } from "../fragment-types.js";
import { shadowAlgorithm as esm } from "./shadow-fragment-esm.js";
import { createPreparedShadowFragment } from "./shadow-fragment-builder.js";
import { shadowAlgorithm as pcf } from "./shadow-fragment-pcf.js";

export type { ShadowLightSlot } from "./shadow-fragment-builder.js";
import type { ShadowLightSlot } from "./shadow-fragment-builder.js";

/** Create a fragment with both fallback shadow algorithms available. */
export function createShadowFragment(id: string, shadowLights: ShadowLightSlot[]): ShaderFragment {
    return createPreparedShadowFragment(id, shadowLights, esm, pcf);
}
