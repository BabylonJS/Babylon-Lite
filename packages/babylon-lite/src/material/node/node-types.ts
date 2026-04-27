/** Node Material — internal graph + emitter types.
 *
 *  All types here are pure data. Block emitters are pure functions imported lazily
 *  from `./blocks/*` via the registry. No module-level state lives here.
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { UboField, BindingDecl, VertexAttribute, Varying } from "../../shader/fragment-types.js";

// ─── Graph (parser output) ───────────────────────────────────────────

/** A single connection point on a block — input only.
 *  Output connection types are resolved by the emitter at graph-walk time. */
export interface NodeConnection {
    /** Connection name on the owning block (e.g. "rgb", "uv", "color"). */
    readonly name: string;
    /** For inputs only: the upstream block id + output name. Null if unconnected. */
    readonly source: NodeConnectionRef | null;
}

export interface NodeConnectionRef {
    readonly blockId: number;
    readonly outputName: string;
}

/** Parsed block in the graph. */
export interface NodeBlock {
    readonly id: number;
    /** BJS class name (e.g. "InputBlock", "TransformBlock", "FragmentOutputBlock"). */
    readonly className: string;
    /** Author-provided block name. */
    readonly name: string;
    /** Inputs by name. */
    readonly inputs: ReadonlyMap<string, NodeConnection>;
    /** Output names (type is resolved by the emitter). */
    readonly outputs: ReadonlySet<string>;
    /** Original serialized JSON for emitters that need extra fields (mode, value, etc.). */
    readonly serialized: Readonly<Record<string, unknown>>;
}

/** Parsed graph. Roots are FragmentOutputBlock + VertexOutputBlock (located by className). */
export interface NodeGraph {
    readonly blocks: ReadonlyMap<number, NodeBlock>;
    /** Named overridable inputs (uniform InputBlocks) — name → block id. */
    readonly namedInputs: ReadonlyMap<string, number>;
    /** BJS alpha mode (0=DISABLE, 2=COMBINE, …). Determines the GPU blend equation. */
    readonly alphaMode: number;
    /** Whether the material requires alpha blending at runtime.
     *  Derived from the graph (FragmentOutputBlock.a is connected) plus
     *  JSON-level overrides (`_needAlphaBlending`, `forceAlphaBlending`). */
    readonly needsAlphaBlending: boolean;
}

// ─── WGSL value types ───────────────────────────────────────────────

export type NodeValueType = "f32" | "vec2f" | "vec3f" | "vec4f" | "mat4f" | "texture2d" | "textureCube";

/** Typed WGSL expression produced by an emitter. */
export interface NodeExpr {
    readonly expr: string;
    readonly type: NodeValueType;
}

export const WGSL: Readonly<Record<NodeValueType, string>> = {
    f32: "f32",
    vec2f: "vec2<f32>",
    vec3f: "vec3<f32>",
    vec4f: "vec4<f32>",
    mat4f: "mat4x4<f32>",
    texture2d: "texture_2d<f32>",
    textureCube: "texture_cube<f32>",
};

// ─── Shader stage ───────────────────────────────────────────────────

/** Which shader stage an emitter writes into. Neutral blocks can run in either;
 *  the walker places them in the stage of their consumer (fragment by default). */
export type Stage = "vertex" | "fragment";

// ─── Emitter API ────────────────────────────────────────────────────

/** Accumulators for a single shader stage. */
export interface StageState {
    /** Top-level helper declarations (functions, constants) keyed by canonical id. */
    readonly helpers: Map<string, string>;
    /** Statements emitted inside main(). */
    readonly body: string[];
    /** Memoized (blockId, outputName) → expr for already-emitted values in this stage. */
    readonly memo: Map<string, NodeExpr>;
}

/** Build state threaded through every emit call. */
export interface NodeBuildState {
    readonly vertex: StageState;
    readonly fragment: StageState;
    // Shared across stages:
    readonly vertexAttributes: VertexAttribute[];
    readonly varyings: Varying[];
    readonly nodeUboFields: UboField[];
    readonly bindings: BindingDecl[];
    readonly textures: NodeTextureBinding[];
    /** Monotonic counter for SSA temp names, shared across stages. */
    nextTemp: number;
    /** Set by any block that references the scene lights UBO (LightBlock,
     *  LightInformationBlock, …). The pipeline builder allocates a binding +
     *  struct decls + BGL entry when true. */
    usesLightsUbo: boolean;
    /** Set by MorphTargetsBlock. The pipeline allocates two vertex-only
     *  bindings (morph texture + morph UBO), declares the struct, and adds
     *  a `@builtin(vertex_index)` param to vs_main. */
    usesMorphTargets: boolean;
    /** Set by parseNodeMaterialFromSnippet when shadowGenerators are supplied.
     *  The pipeline allocates shadow bindings (texture + sampler + UBO) per
     *  shadow-casting light, emits light-space varyings in vs_main, and injects
     *  a `nme_computeShadowFactors` helper that LightBlock calls before the
     *  lighting loop. Zero entries = no bindings, no WGSL — invisible to scenes
     *  without shadows. */
    shadowLights: { lightIndex: number; shadowType: "esm" | "pcf" }[];
    /** Set by ReflectionBlock or any block that needs scene env textures
     *  (specular cube + BRDF LUT + SH irradiance). The pipeline allocates
     *  4 group-1 bindings (env_iblTexture/sampler + env_brdfLUT/sampler) and
     *  extends the NME scene UBO with SH coefficients + envRotationY +
     *  lodGenerationScale + environmentIntensity. Materials without env
     *  pay zero — empty default. */
    usesEnv: boolean;
    /** Set by ClearCoatBlock; tells PBRMetallicRoughnessBlock to walk into
     *  the connected ClearCoatBlock and emit the clear-coat layer code path
     *  (extra GGX layer + Fresnel modulation of the base specular). */
    usesClearcoat: boolean;
    /** Set by SheenBlock; tells PBRMetallicRoughnessBlock to add the Charlie
     *  NDF + Ashikhmin visibility sheen layer (cloth/velvet look). */
    usesSheen: boolean;
    /** Set by AnisotropyBlock; reserved for future anisotropic GGX path.
     *  Currently used only to validate marker plumbing in scene 70 — at
     *  intensity=0 the BJS anisotropic path reduces to standard GGX. */
    usesAnisotropy: boolean;
    /** Set by SubSurfaceBlock; reserved for future SS path. Marker only. */
    usesSubsurface: boolean;
    /** When false (default), BonesBlock emits a pass-through of its `world`
     *  input — no skeleton binding is required. Set to true only when every
     *  mesh using this material has a skeleton. */
    hasSkeleton: boolean;
    /** When false (default), InstancesBlock passes through the uniform world
     *  matrix. Set to true when thin-instance attributes are bound. */
    hasInstances: boolean;
}

export interface NodeTextureBinding {
    readonly name: string;
    readonly kind: "texture2d" | "textureCube";
    readonly texture: Texture2D | null;
}

/** A block emitter — pure functions, no per-instance state. */
export interface BlockEmitter {
    /** Class name this emitter handles (e.g. "InputBlock"). */
    readonly className: string;
    /** Which shader stage this block produces into. Defaults to "fragment". */
    readonly stage?: Stage;
    /** Terminal "side-effect" block that has no outputs the graph reads (e.g.
     *  DiscardBlock). emitGraph force-emits these after the root walk so they
     *  participate even without a downstream consumer. */
    readonly sideEffect?: boolean;
    /** Emit the value of `outputName` for `block`, returning a typed WGSL expression. */
    emit(block: NodeBlock, outputName: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr;
}

export interface NodeEmitContext {
    /** Resolve an input → WGSL expression (handles memoization + recursive walk). */
    readonly resolve: (block: NodeBlock, inputName: string, stage: Stage, state: NodeBuildState) => NodeExpr;
    /** Resolve a specific (producerBlock, outputName) — used when one block reads another directly. */
    readonly resolveOutput: (producer: NodeBlock, outputName: string, stage: Stage, state: NodeBuildState) => NodeExpr;
    /** Mint a fresh SSA temp name. */
    readonly temp: (state: NodeBuildState, prefix?: string) => string;
    /** Cast a typed expression to a target WGSL type when the shapes differ. */
    readonly cast: (value: NodeExpr, target: NodeValueType) => NodeExpr;
    /** Access the surrounding graph (so emitters can find upstream blocks). */
    readonly graph: NodeGraph;
}
