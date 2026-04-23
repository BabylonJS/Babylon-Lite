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
import { fetchSnippetSource, parseNodeMaterialSource, findBlockByClassName } from "./node-parser.js";
import { loadGraphEmitters, emitGraph } from "./node-emitter.js";
import type { NodeBuildState, NodeGraph, NodeValueType } from "./node-types.js";
import { compileNodePipeline, type NodeCompileResult } from "./node-pipeline.js";

// ─── Public API types ───────────────────────────────────────────────

export interface NodeMaterial {
    readonly inputs: Record<string, NodeInputHandle>;
    readonly _buildGroup: MeshGroupBuilder;
}

export interface NodeInputHandle {
    readonly type: "f32" | "vec2f" | "vec3f" | "vec4f" | "texture2d";
    value?: number | number[];
    texture?: Texture2D | null;
}

export interface ParseNodeMaterialOptions {
    readonly snippetServer?: string;
    /** Pre-resolved JSON (object or string). When provided, bypasses the network. */
    readonly json?: string | object;
}

// ─── Internal shape (what the renderable + updater read) ────────────

export interface NodeMaterialInternal extends NodeMaterial {
    readonly _compile: NodeCompileResult;
    readonly _state: NodeBuildState;
    readonly _graph: NodeGraph;
    /** Ordered list of vertex attribute names that the pipeline's vertex buffers expect. */
    readonly _vertexAttrNames: readonly string[];
    _sceneUBO: GPUBuffer | null;
    _nodeUBO: GPUBuffer | null;
    _uboDirty: boolean;
    _uniformValues: Map<string, UniformSlot>;
}

interface UniformSlot {
    readonly name: string;
    readonly type: NodeValueType;
    readonly offsetBytes: number;
    readonly values: Float32Array;
}

// ─── Parse entry point ──────────────────────────────────────────────

export async function parseNodeMaterialFromSnippet(engine: EngineContext, snippetId: string, options: ParseNodeMaterialOptions = {}): Promise<NodeMaterial> {
    const source = options.json !== undefined ? (typeof options.json === "string" ? JSON.parse(options.json) : options.json) : await fetchSnippetSource(snippetId, options.snippetServer);

    const graph = parseNodeMaterialSource(source);
    const emitters = await loadGraphEmitters(graph);

    const fragRoot = findBlockByClassName(graph, "FragmentOutputBlock");
    if (!fragRoot) {
        throw new Error("NodeMaterial: graph has no FragmentOutputBlock");
    }
    const vertRoot = findBlockByClassName(graph, "VertexOutputBlock");

    const { vertexWgsl, fragmentWgsl, state } = emitGraph(graph, emitters, fragRoot.id, vertRoot ? vertRoot.id : null);

    const engineInternal = engine as EngineContextInternal;
    const compile = compileNodePipeline(state, vertexWgsl, fragmentWgsl, {
        engine: engineInternal,
        format: engineInternal.format,
        msaaSamples: engineInternal.msaaSamples,
    });

    // Build the `inputs` map: one NodeInputHandle per named uniform.
    const inputs: Record<string, NodeInputHandle> = {};
    const uniformValues = new Map<string, UniformSlot>();
    for (const [name, blockId] of graph.namedInputs) {
        const block = graph.blocks.get(blockId)!;
        const fieldName = sanitize(block.name || `input${block.id}`);
        const offset = compile.nodeUboOffsets.get(fieldName);
        if (offset === undefined) {
            continue;
        }
        const type = bjsTypeToNodeType((block.serialized["type"] as number | undefined) ?? 0x10);
        if (type === "mat4f") {
            continue;
        }
        const len = floatCount(type);
        const defaultValues = extractDefault(block.serialized["value"], type);
        const arr = new Float32Array(len);
        arr.set(defaultValues);
        const slot: UniformSlot = { name: fieldName, type, offsetBytes: offset, values: arr };
        uniformValues.set(fieldName, slot);

        const handleType = handleTypeOf(type);
        // capture material so the setter can mark it dirty.
        const setDirty = () => {
            material._uboDirty = true;
        };
        const handle: NodeInputHandle = {
            type: handleType,
            get value(): number | number[] {
                return handleType === "f32" ? slot.values[0]! : Array.from(slot.values);
            },
            set value(v: number | number[]) {
                if (typeof v === "number") {
                    slot.values[0] = v;
                } else {
                    slot.values.set(v);
                }
                setDirty();
            },
        } as NodeInputHandle;
        inputs[name] = handle;
    }

    const attrNames = state.vertexAttributes.map((a) => a.name);

    const _buildGroup: MeshGroupBuilder = async (scene, meshes): Promise<MeshGroupBuildResult> => {
        const { buildNodeMeshRenderables } = await import("./node-renderable.js");
        return buildNodeMeshRenderables(scene, meshes);
    };

    const material: NodeMaterialInternal = {
        inputs,
        _buildGroup,
        _compile: compile,
        _state: state,
        _graph: graph,
        _vertexAttrNames: attrNames,
        _sceneUBO: null,
        _nodeUBO: null,
        _uboDirty: false,
        _uniformValues: uniformValues,
    };
    return material;
}

// ─── Helpers ────────────────────────────────────────────────────────

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function bjsTypeToNodeType(t: number): NodeValueType {
    if (t === 0x1 || t === 0x2) return "f32";
    if (t === 0x4) return "vec2f";
    if (t === 0x8 || t === 0x20) return "vec3f";
    if (t === 0x10 || t === 0x40) return "vec4f";
    if (t === 0x80) return "mat4f";
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
        while (out.length < n) out.push(0);
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
            while (picks.length < n) picks.push(0);
            return picks.slice(0, n);
        }
        const rgba: number[] = [];
        for (const k of ["r", "g", "b", "a"]) {
            if (typeof obj[k] === "number") {
                rgba.push(obj[k]);
            }
        }
        if (rgba.length > 0) {
            while (rgba.length < n) rgba.push(1);
            return rgba.slice(0, n);
        }
    }
    return new Array(n).fill(0);
}

// ─── UBO writer ─────────────────────────────────────────────────────

export function writeNodeUBO(engine: EngineContextInternal, buffer: GPUBuffer, material: NodeMaterialInternal): void {
    const size = material._compile.nodeUboSize;
    if (size === 0) {
        return;
    }
    const scratch = new Float32Array(size / 4);
    for (const slot of material._uniformValues.values()) {
        const dstIdx = slot.offsetBytes >> 2;
        scratch.set(slot.values, dstIdx);
    }
    engine.device.queue.writeBuffer(buffer, 0, scratch);
}
