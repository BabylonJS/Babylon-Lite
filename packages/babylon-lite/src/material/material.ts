/** Base material interface — the polymorphic anchor shared by every concrete
 *  material kind (Standard, PBR, …).
 *
 *  Concrete materials add their own user-facing properties (colors, textures,
 *  factors), while the shared `_buildGroup` hook lets the renderer dispatch
 *  source materials through a common path. */
import type { MeshGroupBuilder } from "../render/renderable.js";

export interface Material {
    readonly _buildGroup: MeshGroupBuilder;
    /** Material-owned render feature bits. Mesh-owned bits are computed per renderable. */
    _renderFeatures: MaterialRenderFeatures;
    /** Monotonic source-material UBO version. Renderables track their last seen value independently. */
    _uboVersion: number;
    /** Views created from this material. Used by rebuild helpers to include framework-created views. */
    _views?: MaterialView[];
}

/** Exact material render-feature override used by MaterialView.
 *  Feature bits are interpreted by each concrete material family. */
export interface MaterialRenderFeatures {
    features: number;
    features2?: number;
}

/** A lightweight render view over an editable source material.
 *  The view owns only render-feature bits; all material state (UBO data,
 *  textures, samplers, culling, alpha cutoff, extension data) is read from
 *  {@link source}. */
export interface MaterialView {
    readonly source: Material;
    readonly _renderFeatures: MaterialRenderFeatures;
}

export type MaterialOrView = Material | MaterialView;
