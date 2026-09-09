/** Typed injection points for the Slug text shader.
 *
 *  Analogous to `shader/fragment-types.ts` (`ShaderFragment` + `ShaderTemplate`) on the
 *  material side, but deliberately tiny: text owns a fixed custom `@group(0)` layout with
 *  no mesh/material UBO, no shadow group and no vertex-attribute negotiation, so none of
 *  the generic composer's machinery applies.
 *
 *  This module is types only — it is fully erased at build time and costs zero bytes. It
 *  is also feature-agnostic: no font-weight (or any other feature's) semantics appear here
 *  or in the composer, only the shape of an incremental contribution.
 *
 *  Slot contracts are specified in `docs/lite/architecture/33-text.md` ("Injection slots")
 *  and restated at each interpolation site in `slug-shader.ts`. */

import type { WgslSource } from "../../shader/wgsl.js";

/** Vertex-stage injection points.
 *  - `VO` — extra `VOut` members (comma-terminated; base uses `@location(0..3)`).
 *  - `VD` — dead-slot defaults for those members, assigned on the local `d: VOut`.
 *  - `VB` — shaped glyph bounds: must declare `let sb: vec4<f32>`; `md` (glyph metadata)
 *           and `sy` (style entry) are in scope, and declarations survive until `VA`.
 *  - `VA` — varying assignments on `out`, just before `return out;`. */
export type TextVertexSlot = "VO" | "VD" | "VB" | "VA";

/** Fragment-stage injection points.
 *  - `FI` — extra `FIn` members (comma-terminated), mirroring `VO`.
 *  - `FH` — module-scope helper declarations, after the base helpers (`rcode`, `solveH`,
 *           `solveV`, `ccov`, `cwgt`, `bloc`) and with the `ct`/`bt` textures in scope. A
 *           fragment that needs its own traversal of the glyph's band lists declares it
 *           here as a self-contained function.
 *  - `CO` — coverage override: may read and reassign `var cov: f32` (already clamped to
 *           `[0,1]`), before the coverage-gamma `pow` and the final color write. In scope:
 *           `rc` (em-space render coord), `pe` (pixels-per-em), `gp` (glyph texel origin),
 *           `bm` (max band indices) and `in`.
 *
 *  There are deliberately no per-curve slots inside the base band loops: those loops visit
 *  one band per axis and `break` on a coverage-specific bound, which is complete for a ray
 *  cast but not for any nearest-contour query. */
export type TextFragmentSlot = "FI" | "FH" | "CO";

/** One optional feature's incremental contribution to the Slug shader. */
export interface TextShaderFragment {
    /** @internal Stable id. Folded into the pipeline cache key and the module labels. */
    readonly _id: string;
    /** @internal WGSL injected at named vertex slots. */
    readonly _vertexSlots?: Partial<Record<TextVertexSlot, WgslSource>>;
    /** @internal WGSL injected at named fragment slots. */
    readonly _fragmentSlots?: Partial<Record<TextFragmentSlot, WgslSource>>;
}
