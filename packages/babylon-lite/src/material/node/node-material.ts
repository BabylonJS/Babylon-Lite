/** Node Material — public API (real implementation).
 *
 *  Scenes that don't reference these exports tree-shake the entire
 *  `material/node/` subtree to zero bytes.
 *
 *  Flow: `parseNodeMaterialFromSnippet`
 *    → fetch or inline JSON
 *    → parse (`parseNodeMaterialSource`)
 *    → load referenced emitters (lazy per-block)
 *    → emit WGSL bodies (`emitGraph`)
 *    → wrap + compile GPU pipeline (`compileNodePipeline`)
 *    → return NodeMaterial with `inputs` map + `_buildGroup` dispatcher.
 */

import type { EngineContext, EngineContextInternal } from "../../engine/engine.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { MeshGroupBuilder, MeshGroupBuildResult } from "../../render/renderable.js";
import { parseNodeMaterialSource, findBlockByClassName } from "./node-parser.js";
import { loadGraphEmitters, emitGraph } from "./node-emitter.js";
import type { BlockEmitter, NodeBuildState, NodeGraph, NodeValueType } from "./node-types.js";
import type { Material } from "../material.js";
import { compileNodePipeline, type NodeCompileResult } from "./node-pipeline.js";

// ─── Public API types ───────────────────────────────────────────────

/** A compiled Node Material (Babylon NME graph). Exposes an `inputs` map of
 *  named handles for live uniform/texture updates, and dispatches rendering
 *  through the inherited `_buildGroup` hook. */
export interface NodeMaterial extends Material {
    readonly inputs: Record<string, NodeInputHandle>;
}

/** A live handle to one named Node Material input (uniform or texture). Set
 *  `value` for scalar/vector inputs or `texture` for `texture2d` inputs; writes
 *  flag the material UBO dirty so the change is uploaded next frame. */
export interface NodeInputHandle {
    readonly type: "f32" | "vec2f" | "vec3f" | "vec4f" | "texture2d";
    value?: number | number[];
    texture?: Texture2D | null;
}

/** Options for `parseNodeMaterialFromSnippet()`. */
export interface ParseNodeMaterialOptions {
    readonly snippetServer?: string;
    /** Pre-resolved JSON (object or string). When provided, bypasses the network. */
    readonly json?: string | object;
    /** Texture overrides keyed by TextureBlock / ImageSourceBlock name. */
    readonly textures?: Readonly<Record<string, Texture2D>>;
    /** Shadow generators to integrate into the material. Each contributes
     *  one shadow-light slot whose lightIndex is the position of its light in
     *  `scene.lights` at the time of rendering. Materials built without this
     *  option have zero shadow bindings / zero shadow WGSL. */
    readonly shadowGenerators?: readonly import("../../shadow/shadow-generator.js").ShadowGenerator[];
    /** For each entry in shadowGenerators, the index of the owning light in
     *  scene.lights. When omitted, defaults to [0, 1, …] (first N lights). */
    readonly shadowLightIndices?: readonly number[];
    /** When true, BonesBlock produces a skinned world matrix (requires all
     *  meshes using this material to have a skeleton). Default false. */
    readonly hasSkeleton?: boolean;
    /** When true, InstancesBlock wires per-instance attributes. Default false. */
    readonly hasInstances?: boolean;
    /** Optional graph-specific block loader. Avoids the full default registry when callers know the exact block set. */
    readonly blockLoader?: (className: string) => Promise<BlockEmitter>;
}

// ─── Internal shape (what the renderable + updater read) ────────────

export interface NodeMaterialInternal extends NodeMaterial {
    readonly _compile: NodeCompileResult;
    readonly _state: NodeBuildState;
    readonly _graph: NodeGraph;
    readonly _vertexBody: string;
    readonly _fragmentBody: string;
    /** Ordered list of vertex attribute names that the pipeline's vertex buffers expect. */
    readonly _vertexAttrNames: readonly string[];
    readonly _shadowGenerators: readonly import("../../shadow/shadow-generator.js").ShadowGenerator[];
    /** Whether this material requires alpha blending (derived from graph + JSON flags). */
    readonly _needsAlphaBlending: boolean;
    _nodeUBO: GPUBuffer | null;
    _uboDirty: boolean;
    _uniformValues: Map<string, UniformSlot>;
    /** Per-texture-binding Texture2D slot (populated from options.textures and/or inputs.*.texture). */
    _textureSlots: Map<string, { current: Texture2D | null }>;
    /** Pre-loaded env helpers (only populated when state.usesEnv was set during emitGraph).
     *  Forwarded to the renderable so it doesn't have to dynamic-import again. */
    _envHelpers: typeof import("./node-env.js") | null;
}

interface UniformSlot {
    readonly _name: string;
    readonly _type: NodeValueType;
    readonly _offsetBytes: number;
    readonly _values: Float32Array;
}

// ─── Parse entry point ──────────────────────────────────────────────

/** Parse a Babylon NME graph (by snippet ID or inline JSON), emit WGSL, compile
 *  the GPU pipeline, and return a ready-to-render `NodeMaterial`.
 *  @param engine - Engine context.
 *  @param snippetId - Snippet server ID; ignored when `options.json` is supplied.
 *  @param options - Inline JSON, texture overrides, shadow generators, and graph flags.
 *  @returns A promise resolving to the compiled `NodeMaterial`. */
export async function parseNodeMaterialFromSnippet(engine: EngineContext, snippetId: string, options: ParseNodeMaterialOptions = {}): Promise<NodeMaterial> {
    const source =
        options.json !== undefined
            ? typeof options.json === "string"
                ? JSON.parse(options.json)
                : options.json
            : await (await import("./node-snippet.js")).fetchSnippetSource(snippetId, options.snippetServer);

    const graph = parseNodeMaterialSource(source);
    const emitters = await loadGraphEmitters(graph, options.blockLoader);

    const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock");
    if (!fragRoot) {
        throw new Error("NodeMaterial: graph has no FragmentOutputBlock");
    }
    const vertRoot = findBlockByClassName(graph, "VertexOutputBlock");

    // Pre-populate shadow metadata BEFORE emitGraph so LightBlock can dispatch
    // to nme_computeShadowFactors(...) during emission. When no shadow
    // generators are supplied, state.shadowLights stays empty and zero shadow
    // WGSL / zero shadow bindings are emitted (tree-shakable).
    const shadowLightsPre: { lightIndex: number; shadowType: "esm" | "pcf" }[] = [];
    if (options.shadowGenerators && options.shadowGenerators.length > 0) {
        const defaultIdx = options.shadowGenerators.map((_, i) => i);
        const indices = options.shadowLightIndices ?? defaultIdx;
        for (let i = 0; i < options.shadowGenerators.length; i++) {
            shadowLightsPre.push({ lightIndex: indices[i]!, shadowType: options.shadowGenerators[i]!._shadowType });
        }
    }

    const { vertexWgsl, fragmentWgsl, state } = emitGraph(graph, emitters, fragRoot.id, vertRoot ? vertRoot.id : null, shadowLightsPre, {
        hasSkeleton: options.hasSkeleton ?? false,
        hasInstances: options.hasInstances ?? false,
    });
    await resolvePbrMrHelpers(state);

    // Dynamic import: env IBL helpers in node-env.ts are only loaded when the
    // graph emitted state.usesEnv. Scenes without ReflectionBlock+PBR-MR never
    // bundle this module.
    let envHelpers: typeof import("./node-env.js") | null = null;
    let _envEmitter: typeof import("./node-env.js").emitEnv | undefined;
    if (state.usesEnv) {
        envHelpers = await import("./node-env.js");
        _envEmitter = envHelpers.emitEnv;
    }

    // Dynamic import: the PCF/ESM WGSL helpers live in node-shadow.ts and
    // are only loaded when the caller supplied shadowGenerators. Scenes
    // without shadows never bundle this module.
    let _shadowEmitter: typeof import("./node-shadow.js").emitShadow | undefined;
    if (options.shadowGenerators && options.shadowGenerators.length > 0) {
        _shadowEmitter = (await import("./node-shadow.js")).emitShadow;
    }

    const _engine = engine as EngineContextInternal;
    const compile = compileNodePipeline(state, vertexWgsl, fragmentWgsl, {
        _engine,
        _format: _engine.format,
        _msaaSamples: _engine.msaaSamples,
        _backFaceCulling: graph.backFaceCulling,
        _alphaMode: graph.needsAlphaBlending ? graph.alphaMode : 0,
        _envEmitter,
        _shadowEmitter,
    });

    // Build the `inputs` map: one NodeInputHandle per named uniform.
    const inputs: Record<string, NodeInputHandle> = {};
    const uniformValues = new Map<string, UniformSlot>();
    for (const [name, blockId] of graph.namedInputs) {
        const block = graph.blocks.get(blockId)!;
        const _name = sanitize(block.name || `input${block.id}`);
        const _offsetBytes = compile._nodeUboOffsets.get(_name);
        if (_offsetBytes === undefined) {
            continue;
        }
        const _type = bjsTypeToNodeType((block.serialized["type"] as number | undefined) ?? 0x10);
        if (_type === "mat4f") {
            continue;
        }
        const len = floatCount(_type);
        const defaultValues = extractDefault(block.serialized["value"], _type);
        const _values = new Float32Array(len);
        _values.set(defaultValues);
        const slot: UniformSlot = { _name, _type, _offsetBytes, _values };
        uniformValues.set(_name, slot);

        const handleType = handleTypeOf(_type);
        // capture material so the setter can mark it dirty.
        const setDirty = () => {
            material._uboDirty = true;
        };
        const handle: NodeInputHandle = {
            type: handleType,
            get value(): number | number[] {
                return handleType === "f32" ? slot._values[0]! : Array.from(slot._values);
            },
            set value(v: number | number[]) {
                if (typeof v === "number") {
                    slot._values[0] = v;
                } else {
                    slot._values.set(v);
                }
                setDirty();
            },
        } as NodeInputHandle;
        inputs[name] = handle;
    }

    // Second pass: write defaults for unnamed / constant InputBlocks whose
    // values exist in the UBO but were skipped by the namedInputs loop above
    // (e.g. blocks with empty names or isConstant=true).
    for (const block of graph.blocks.values()) {
        if (block.className !== "InputBlock") {
            continue;
        }
        const _name = sanitize(block.name || `input${block.id}`);
        if (uniformValues.has(_name)) {
            continue;
        } // already handled above
        const _offsetBytes = compile._nodeUboOffsets.get(_name);
        if (_offsetBytes === undefined) {
            continue;
        }
        const _type = bjsTypeToNodeType((block.serialized["type"] as number | undefined) ?? 0x10);
        if (_type === "mat4f") {
            continue;
        }
        const len = floatCount(_type);
        const defaultValues = extractDefault(block.serialized["value"], _type);
        const _values = new Float32Array(len);
        _values.set(defaultValues);
        uniformValues.set(_name, { _name, _type, _offsetBytes, _values });
    }

    const attrNames = state.vertexAttributes.map((a) => a._name);

    // Per-texture handles (populated from options.textures, then exposed via inputs).
    const textureSlots = new Map<string, { current: Texture2D | null }>();
    for (const tb of compile._textureBindings) {
        const slot = { current: options.textures?.[tb._name] ?? null };
        textureSlots.set(tb._name, slot);
        const handle: NodeInputHandle = {
            type: "texture2d",
            get texture(): Texture2D | null {
                return slot.current;
            },
            set texture(v: Texture2D | null) {
                slot.current = v;
            },
        } as NodeInputHandle;
        inputs[tb._name] = handle;
    }

    const _buildGroup: MeshGroupBuilder = async (scene, meshes): Promise<MeshGroupBuildResult> => {
        const { buildNodeMeshRenderables } = await import("./node-renderable.js");
        const result = buildNodeMeshRenderables(scene, meshes);
        _buildGroup._rebuildSingle = result.rebuildSingle;
        return result;
    };
    _buildGroup._materialFamily = "node";

    const material: NodeMaterialInternal = {
        inputs,
        _renderFeatures: { features: 0 },
        _buildGroup,
        _uboVersion: 0,
        _compile: compile,
        _state: state,
        _graph: graph,
        _vertexBody: vertexWgsl,
        _fragmentBody: fragmentWgsl,
        _vertexAttrNames: attrNames,
        _shadowGenerators: options.shadowGenerators ?? [],
        _needsAlphaBlending: graph.needsAlphaBlending,
        _nodeUBO: null,
        _uboDirty: false,
        _uniformValues: uniformValues,
        _textureSlots: textureSlots,
        _envHelpers: envHelpers,
    };
    return material;
}

function isCorePbrMrRequest(request: import("./node-types.js").NodePbrMrHelperRequest): boolean {
    return (
        !request.useClearcoat &&
        !request.useSheen &&
        !request.useRefraction &&
        !request.useSubsurface &&
        !request.useAnisotropy &&
        !request.useShAlbedoScaling &&
        !request.useCcBump &&
        !request.useCcTint &&
        !request.useSpecularAA &&
        !request.remapClearcoatF0
    );
}

async function resolvePbrMrHelpers(state: NodeBuildState): Promise<void> {
    if (state.pbrMrHelperRequests.length === 0) {
        return;
    }
    if (state.pbrMrHelperRequests.some((request) => !isCorePbrMrRequest(request))) {
        throw new Error("NodeMaterial: advanced PBR-MR helper request must be emitted by the full PBR-MR block");
    }
    const core = await import("./blocks/pbr-mr-helper-core.js");
    for (const request of state.pbrMrHelperRequests) {
        state.fragment.helpers.set(request.key, core.buildPbrMrHelperCore(request));
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function bjsTypeToNodeType(t: number): NodeValueType {
    if (t === 0x1 || t === 0x2) {
        return "f32";
    }
    if (t === 0x4) {
        return "vec2f";
    }
    if (t === 0x8 || t === 0x20) {
        return "vec3f";
    }
    if (t === 0x10 || t === 0x40) {
        return "vec4f";
    }
    if (t === 0x80) {
        return "mat4f";
    }
    throw new Error(`NodeMaterial: unsupported BJS connection point type 0x${t.toString(16)}`);
}

function floatCount(type: NodeValueType): number {
    switch (type) {
        case "f32":
            return 1;
        case "vec2f":
            return 2;
        case "vec3f":
            return 3;
        case "vec4f":
            return 4;
        case "mat4f":
            return 16;
        default:
            return 0;
    }
}

function handleTypeOf(t: NodeValueType): NodeInputHandle["type"] {
    if (t === "mat4f" || t === "texture2d" || t === "textureCube") {
        return "vec4f";
    }
    return t;
}

function extractDefault(raw: unknown, type: NodeValueType): number[] {
    const n = floatCount(type);
    if (typeof raw === "number") {
        return [raw];
    }
    if (Array.isArray(raw)) {
        const out = raw.slice(0, n).map((v) => (typeof v === "number" ? v : 0));
        while (out.length < n) {
            out.push(0);
        }
        return out;
    }
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, number>;
        const picks: number[] = [];
        for (const k of ["x", "y", "z", "w"]) {
            if (typeof obj[k] === "number") {
                picks.push(obj[k]);
            }
        }
        if (picks.length > 0) {
            while (picks.length < n) {
                picks.push(0);
            }
            return picks.slice(0, n);
        }
        const rgba: number[] = [];
        for (const k of ["r", "g", "b", "a"]) {
            if (typeof obj[k] === "number") {
                rgba.push(obj[k]);
            }
        }
        if (rgba.length > 0) {
            while (rgba.length < n) {
                rgba.push(1);
            }
            return rgba.slice(0, n);
        }
    }
    return new Array(n).fill(0);
}

// ─── UBO writer ─────────────────────────────────────────────────────

export function writeNodeUBO(engine: EngineContextInternal, buffer: GPUBuffer, material: NodeMaterialInternal): void {
    const size = material._compile._nodeUboSize;
    if (size === 0) {
        return;
    }
    const scratch = new Float32Array(size / 4);
    for (const slot of material._uniformValues.values()) {
        const dstIdx = slot._offsetBytes >> 2;
        scratch.set(slot._values, dstIdx);
    }
    engine.device.queue.writeBuffer(buffer, 0, scratch);
}
