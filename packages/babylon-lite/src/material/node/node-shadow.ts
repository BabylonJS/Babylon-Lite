/** Combined synchronous compatibility entry. Material parsing uses algorithm-specific preparation. */
import { shadowAlgorithm as esm } from "../../shader/fragments/shadow-fragment-esm.js";
import { shadowAlgorithm as pcf } from "../../shader/fragments/shadow-fragment-pcf.js";
import { emitPreparedShadow, type NodeShadowEmitter } from "./node-shadow-emitter.js";

export type { ShadowBinding, ShadowEmit } from "./node-shadow-emitter.js";

const algorithms = { esm, pcf };

/** Emit Node shadow declarations with both sampling algorithms available. */
export const emitShadow: NodeShadowEmitter = (slots, startBinding, varyings) => emitPreparedShadow(slots, startBinding, varyings, algorithms);
