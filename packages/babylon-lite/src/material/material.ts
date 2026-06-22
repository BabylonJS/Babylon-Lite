/** Base material interface — the polymorphic anchor shared by every concrete
 *  material kind (Standard, PBR, …).
 *
 *  Concrete materials add their own user-facing properties (colors, textures,
 *  factors), while the shared `_buildGroup` hook lets the renderer dispatch
 *  materials through a common path. */
import type { MeshGroupBuilder } from "../render/renderable.js";
import type { LiteMetadata } from "../metadata.js";

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
    /** User metadata. glTF loads populate `metadata.gltf.extras` when source extras exist. */
    metadata?: LiteMetadata;
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

/** Optional stencil-test state baked into a material's main-pass pipeline. Shared by every concrete material kind
 *  (Standard, PBR, Shader) so none has to depend on another. Lets one material WRITE the stencil buffer where it
 *  draws (a mask) and another DISCARD fragments where the stencil was written — with NO dynamic stencil reference:
 *  a writer uses `compare:"always"` + `passOp:"increment-clamp"` (stencil 0→1 where it draws); a tester uses
 *  `compare:"equal"` (passes only where the stencil is still 0, i.e. NOT written), since the render pass's default
 *  stencil reference is 0. Only takes effect on a stencil-capable depth target (the main color pass); ignored on
 *  depth-only/shadow targets. Assigning `material.stencil` is inert until {@link enableMaterialStencil} is called
 *  (the opt-in that keeps stencil-free scenes byte-identical) — call it once before `registerScene`. */
export interface StencilState {
    /** Stencil compare function, applied to front & back faces. Default `"always"`. */
    readonly compare?: GPUCompareFunction;
    /** Stencil operation when the stencil + depth tests both pass. Default `"keep"`. */
    readonly passOp?: GPUStencilOperation;
    /** Stencil operation when the stencil test fails. Default `"keep"`. */
    readonly failOp?: GPUStencilOperation;
    /** Stencil operation when the stencil test passes but depth fails. Default `"keep"`. */
    readonly depthFailOp?: GPUStencilOperation;
    /** Stencil read mask. Default `0xFF`. */
    readonly readMask?: number;
    /** Stencil write mask. Default `0xFF`. */
    readonly writeMask?: number;
}

/** A lightweight render view over an editable source material.
 *  The view is also a Material: it inherits material state from {@link source}
 *  through the prototype chain and owns only render-feature bits. Keeping views
 *  material-compatible lets ordinary render paths read properties normally, so
 *  scenes that never create views do not retain view-specific unwrap branches.
 *
 *  Specialized views (e.g. the Standard geometry MRT view) override
 *  `_buildGroup` with a view-specific builder whose
 *  `_rebuildSingle` builds the right kind of Renderable — no per-family
 *  branching is required in the core render-task. */
export interface MaterialView extends Material {
    readonly source: Material;
    /** @internal */
    _renderFeatures: MaterialRenderFeatures;
}
