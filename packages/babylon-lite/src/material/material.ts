/** Base material interface — the polymorphic anchor shared by every concrete
 *  material kind (Standard, PBR, …).
 *
 *  Public surface is intentionally empty: concrete materials add their own
 *  user-facing properties (colors, textures, factors). The shared engine-side
 *  contract lives on {@link MaterialInternal} below — accessed by the renderer
 *  through a single cast at the dispatch site. */
export interface Material {}

import type { MeshGroupBuilder } from "../render/renderable.js";

/** @internal Engine-side view of a Material.
 *
 *  Concrete material props (StandardMaterialPropsInternal, PbrMaterialPropsInternal)
 *  extend this so the renderer can:
 *   - dispatch group / single-mesh builds polymorphically via `_buildGroup`
 *   - skip redundant material-UBO uploads via `_uboDirty`. */
export interface MaterialInternal extends Material {
    readonly _buildGroup: MeshGroupBuilder;
    /** Set to true when a UBO-relevant property changes. Cleared after upload. */
    _uboDirty?: boolean;
}
