/** Unified glTF feature protocol.
 *
 *  Every non-core glTF capability — material extensions, skeletons, morph targets,
 *  animations, variants, future things like KHR_lights_punctual, … — is exposed
 *  as a `GltfFeature`. The core loader has zero hardcoded knowledge of any of
 *  these: it just walks the registered feature list, runs whichever hook each
 *  one implements, and merges the results.
 *
 *  Each feature module is dynamic-imported on demand: the loader calls each
 *  registered `needs(json)` predicate (defined eagerly in load-gltf's registry)
 *  and only fetches modules whose predicate returns true. Unknown features cost
 *  zero bytes in bundles that don't trigger them.
 */

import type { Mat4 } from "../math/types.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { AssetContainer } from "../asset-container.js";
import type { Mesh, MeshInternal } from "../mesh/mesh.js";
import type { GltfMatExtCtx, GltfMaterialData } from "./gltf-material.js";
import type { GltfMeshData } from "./load-gltf.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { TextureWrapFn } from "./gltf-pbr-builder.js";

/** Per-load context handed to every non-material feature hook. */
export interface GltfLoadCtx {
    _engine: EngineContextInternal;
    _json: any;
    _binChunk: DataView;
    _baseUrl: string;
    _parentMap: Map<number, number>;
    _worldMatrixCache: Map<number, Mat4>;
    /** All material-layer features active for this load (so e.g. variants can re-use them). */
    _matExts: GltfFeature[];
    /** Composed texture-wrap function aggregating every active feature's
     *  `wrapTexture` hook. Identity when no feature contributes one. */
    _wrapTex: TextureWrapFn;
    /** glTF-node-index → SceneNode, populated by buildNodeHierarchy. Consumers:
     *  KHR_node_visibility (load-time), KHR_animation_pointer (runtime pointer writers).
     *  `undefined` for a given index means the node was unreachable from any scene root. */
    _nodeMap?: (TransformNode | undefined)[];
}

/** Pre-decoded primitive data keyed by the primitive object. Features like
 *  KHR_draco_mesh_compression populate this in their `preMesh` hook so that
 *  the core mesh-extraction loop stays feature-agnostic. */
export interface DecodedPrimitive {
    _attributes: Map<string, Float32Array | Uint32Array | Int32Array>;
    _indices: Uint32Array;
    _vertexCount: number;
    _indexCount: number;
}

/** A glTF feature module. Each module implements one or more of the four hooks. */
export interface GltfFeature {
    /** Diagnostic id, e.g. "KHR_materials_clearcoat" or "_skeleton". */
    id: string;
    /** Pre-extract hook: runs before mesh extraction. Returns a map of glTF
     *  primitive objects to pre-decoded attribute/index data. Used by e.g. Draco. */
    preMesh?(json: unknown, binChunk: DataView, baseUrl: string): Promise<Map<unknown, DecodedPrimitive>>;
    /** Material-layer hook: contributes a partial PbrMaterialProps per material. */
    applyMaterial?(mat: GltfMaterialData, ctx: GltfMatExtCtx): Promise<Partial<PbrMaterialProps> | null>;
    /** Texture-wrap hook: given a textureInfo and an already-uploaded Texture2D,
     *  returns either the same Texture2D or a fresh wrapper carrying extra
     *  per-texture state (e.g. KHR_texture_transform patches `uScale/vScale/
     *  uOffset/vOffset/uAng` via `cloneTexture2D`). Called eagerly during
     *  material assembly. Unknown textureInfos must return `tex` unchanged. */
    wrapTexture?(tex: Texture2D, texInfo: unknown): Texture2D;
    /** Per-mesh hook: mutates a freshly-uploaded `MeshInternal`
     *  (e.g. attaches `mesh.skeleton`, `mesh.morphTargets`). Runs in parallel
     *  for each mesh inside the loader's mesh-upload Promise.all. */
    applyMesh?(meshData: GltfMeshData, mesh: MeshInternal, ctx: GltfLoadCtx): Promise<void>;
    /** Per-asset hook: contributes a fragment merged into the final `AssetContainer`
     *  (e.g. `animationGroups`, `materialVariants`). Runs once after the mesh
     *  hierarchy is built. */
    applyAsset?(meshes: Mesh[], root: TransformNode, ctx: GltfLoadCtx): Promise<Partial<AssetContainer>>;
}
