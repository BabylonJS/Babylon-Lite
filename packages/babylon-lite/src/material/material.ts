/** Base material interface — the polymorphic anchor shared by every concrete
 *  material kind (Standard, PBR, …).
 *
 *  Concrete materials add their own user-facing properties (colors, textures,
 *  factors), while the shared `_buildGroup` hook lets the renderer dispatch
 *  materials through a common path. */
import type { MeshGroupBuilder } from "../render/renderable.js";

/** Base material interface — the polymorphic anchor shared by every concrete
 *  material kind (Standard, PBR, Shader, Node). Concrete materials add their own
 *  user-facing properties while the shared `_buildGroup` hook lets the renderer
 *  dispatch every material through a common path. */
export interface Material {
    /** @internal */
    readonly _buildGroup: MeshGroupBuilder;
    /** Optional human-readable name. Populated by loaders from the source asset
     *  (e.g. the glTF material name) so callers can look a material up by name. */
    name?: string;
    /** @internal Material-owned render feature bits. Mesh-owned bits are computed per renderable. */
    _renderFeatures?: MaterialRenderFeatures;
    /** @internal Monotonic material UBO version. Renderables track their last seen value independently. */
    _uboVersion: number;
}

/** Exact material render-feature override used by MaterialView.
 *  Feature bits are interpreted by each concrete material family. */
export interface MaterialRenderFeatures {
    features: number;
    features2?: number;
}

/** A lightweight render view over an editable source material.
 *  The view is also a Material: it inherits material state from {@link source}
 *  through the prototype chain and owns only render-feature bits. Keeping views
 *  material-compatible lets ordinary render paths read properties normally, so
 *  scenes that never create views do not retain view-specific unwrap branches. */
export interface MaterialView extends Material {
    readonly source: Material;
    /** @internal */
    _renderFeatures: MaterialRenderFeatures;
}
