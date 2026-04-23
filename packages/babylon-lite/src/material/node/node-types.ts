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
