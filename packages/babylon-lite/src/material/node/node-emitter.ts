/** Node Material — WGSL emitter core.
 *
 *  Given a parsed NodeGraph, walk it topologically from the FragmentOutput +
 *  VertexOutput roots, calling each block's emitter to emit WGSL. The emitter
 *  API guarantees that every (blockId, outputName) is emitted at most once per
 *  stage (memoization), so downstream consumers share the same SSA temp.
 *
 *  The result is a pair of WGSL source strings (vertex + fragment) plus the
 *  accumulated UBO fields, attributes, varyings, samplers, and texture bindings
 *  needed by the pipeline builder. This module intentionally has no WGSL of its
 *  own beyond empty scaffolding — every shader string comes from a block emitter
 *  so each block tree-shakes independently.
 */

import type { NodeBuildState, NodeEmitContext, NodeExpr, NodeGraph, NodeValueType, Stage, StageState, BlockEmitter } from "./node-types.js";
import { WGSL } from "./node-types.js";
import { loadBlockEmitter } from "./node-registry.js";

// ─── Build-state construction ───────────────────────────────────────

function newStageState(): StageState {
    return {
        helpers: new Map(),
        body: [],
        memo: new Map(),
    };
}

export function createBuildState(): NodeBuildState {
    return {
        vertex: newStageState(),
        fragment: newStageState(),
        vertexAttributes: [],
        varyings: [],
        nodeUboFields: [],
        bindings: [],
        textures: [],
        nextTemp: 0,
        usesLightsUbo: false,
        usesMorphTargets: false,
        usesEnv: false,
        usesClearcoat: false,
        usesSheen: false,
        usesAnisotropy: false,
        usesSubsurface: false,
        shadowLights: [],
        hasSkeleton: false,
        hasInstances: false,
    };
}

// ─── Emitter context ────────────────────────────────────────────────

function memoKey(blockId: number, outputName: string): string {
    return `${blockId}|${outputName}`;
}

function stageOf(state: NodeBuildState, stage: Stage): StageState {
    return stage === "vertex" ? state.vertex : state.fragment;
}

/** Mint a fresh SSA temp name. */
export function mintTemp(state: NodeBuildState, prefix = "t"): string {
    const id = state.nextTemp++;
    return `_${prefix}${id}`;
}

/** Cast a typed WGSL expression to a target type. Throws if no cast is known.
 *  Handles the common vector-widen/narrow cases that NME graphs actually use. */
export function castExpr(value: NodeExpr, target: NodeValueType): NodeExpr {
    if (value.type === target) {
        return value;
    }
    const t = WGSL[target];
    // Narrowing: vec4 -> vec3/vec2/f32 via .xyz/.xy/.x
    if (value.type === "vec4f" && target === "vec3f") {
        return { expr: `(${value.expr}).xyz`, type: target };
    }
    if (value.type === "vec4f" && target === "vec2f") {
        return { expr: `(${value.expr}).xy`, type: target };
    }
    if (value.type === "vec3f" && target === "vec2f") {
        return { expr: `(${value.expr}).xy`, type: target };
    }
    if ((value.type === "vec4f" || value.type === "vec3f" || value.type === "vec2f") && target === "f32") {
        return { expr: `(${value.expr}).x`, type: target };
    }
    // Widening: f32 -> vecN, vec3 -> vec4 (w=1)
    if (value.type === "f32" && (target === "vec2f" || target === "vec3f" || target === "vec4f")) {
        return { expr: `${t}(${value.expr})`, type: target };
    }
    if (value.type === "vec3f" && target === "vec4f") {
        return { expr: `vec4<f32>(${value.expr}, 1.0)`, type: target };
    }
    if (value.type === "vec2f" && target === "vec4f") {
        return { expr: `vec4<f32>(${value.expr}, 0.0, 1.0)`, type: target };
    }
    if (value.type === "vec2f" && target === "vec3f") {
        return { expr: `vec3<f32>(${value.expr}, 0.0)`, type: target };
    }
    throw new Error(`NodeMaterial: cannot cast ${value.type} to ${target} for expression \`${value.expr}\``);
}

interface EmitContextInternal extends NodeEmitContext {
    readonly loadedEmitters: Map<string, BlockEmitter>;
}

function makeContext(graph: NodeGraph, loadedEmitters: Map<string, BlockEmitter>): EmitContextInternal {
    const ctx: EmitContextInternal = {
        graph,
        loadedEmitters,
        temp: (state, prefix) => mintTemp(state, prefix),
        cast: castExpr,
        resolve: (block, inputName, stage, state) => {
            const input = block.inputs.get(inputName);
            if (!input) {
                throw new Error(`NodeMaterial: block "${block.className}" (id=${block.id}) has no input "${inputName}"`);
            }
            if (!input.source) {
                throw new Error(`NodeMaterial: block "${block.className}" (id=${block.id}) input "${inputName}" is not connected`);
            }
            const producer = graph.blocks.get(input.source.blockId);
            if (!producer) {
                throw new Error(`NodeMaterial: dangling connection ${block.id}.${inputName} -> block ${input.source.blockId}`);
            }
            return ctx.resolveOutput(producer, input.source.outputName, stage, state);
        },
        resolveOutput: (producer, outputName, stage, state) => {
            const stageState = stageOf(state, stage);
            const key = memoKey(producer.id, outputName);
            const existing = stageState.memo.get(key);
            if (existing) {
                return existing;
            }
            const emitter = loadedEmitters.get(producer.className);
            if (!emitter) {
                throw new Error(`NodeMaterial: no emitter loaded for block "${producer.className}"`);
            }
            // Blocks that declare a stage preference override the requested stage.
            const targetStage = emitter.stage ?? stage;
            const result = emitter.emit(producer, outputName, targetStage, state, ctx);
            // If the producer ran in a different stage, bridge via varying.
            if (targetStage !== stage) {
                const vname = `v_${producer.id}_${outputName}`;
                bridgeVarying(state, vname, result, targetStage, stage);
                const bridged: NodeExpr = { expr: `in.${vname}`, type: result.type };
                stageState.memo.set(key, bridged);
                return bridged;
            }
            stageState.memo.set(key, result);
            return result;
        },
    };
    return ctx;
}

function bridgeVarying(state: NodeBuildState, varyingName: string, value: NodeExpr, from: Stage, to: Stage): void {
    if (from !== "vertex" || to !== "fragment") {
        throw new Error("NodeMaterial: only vertex->fragment varyings are supported");
    }
    const already = state.varyings.find((v) => v.name === varyingName);
    if (!already) {
        state.varyings.push({ name: varyingName, type: WGSL[value.type] });
        state.vertex.body.push(`out.${varyingName} = ${value.expr};`);
    }
}

// ─── Emitter dispatch ───────────────────────────────────────────────

/** Load all emitters referenced by the graph in a single parallel batch. */
export async function loadGraphEmitters(graph: NodeGraph): Promise<Map<string, BlockEmitter>> {
    const classNames = new Set<string>();
    for (const b of graph.blocks.values()) {
        classNames.add(b.className);
    }
    const map = new Map<string, BlockEmitter>();
    await Promise.all(
        Array.from(classNames).map(async (className) => {
            const e = await loadBlockEmitter(className);
            map.set(className, e);
        })
    );
    return map;
}

// ─── Public entry ───────────────────────────────────────────────────

export interface EmitResult {
    readonly vertexWgsl: string;
    readonly fragmentWgsl: string;
    readonly state: NodeBuildState;
}

/** Walk the graph from the given root (a FragmentOutput or VertexOutput block)
 *  and emit the pair of WGSL shader strings. The caller is responsible for
 *  wrapping the result with the pipeline's bind-group / entry-point scaffolding
 *  (done by `node-pipeline.ts`). */
export function emitGraph(
    graph: NodeGraph,
    loadedEmitters: Map<string, BlockEmitter>,
    fragmentRootId: number,
    vertexRootId: number | null,
    shadowLights?: readonly { lightIndex: number; shadowType: "esm" | "pcf" }[],
    meshCaps?: { hasSkeleton?: boolean; hasInstances?: boolean }
): EmitResult {
    const state = createBuildState();
    if (shadowLights) {
        for (const sl of shadowLights) {
            state.shadowLights.push(sl);
        }
    }
    if (meshCaps) {
        if (meshCaps.hasSkeleton) {
            state.hasSkeleton = true;
        }
        if (meshCaps.hasInstances) {
            state.hasInstances = true;
        }
    }
    const ctx = makeContext(graph, loadedEmitters);

    // Emit fragment root.
    const fragRoot = graph.blocks.get(fragmentRootId);
    if (!fragRoot) {
        throw new Error(`NodeMaterial: fragment root block ${fragmentRootId} not found`);
    }
    const fragEmitter = loadedEmitters.get(fragRoot.className);
    if (!fragEmitter) {
        throw new Error(`NodeMaterial: no emitter for fragment root "${fragRoot.className}"`);
    }
    fragEmitter.emit(fragRoot, "", "fragment", state, ctx);

    if (vertexRootId !== null) {
        const vertRoot = graph.blocks.get(vertexRootId);
        if (!vertRoot) {
            throw new Error(`NodeMaterial: vertex root block ${vertexRootId} not found`);
        }
        const vertEmitter = loadedEmitters.get(vertRoot.className);
        if (!vertEmitter) {
            throw new Error(`NodeMaterial: no emitter for vertex root "${vertRoot.className}"`);
        }
        vertEmitter.emit(vertRoot, "", "vertex", state, ctx);
    }

    // Force-emit side-effect blocks (e.g. DiscardBlock) that have no outputs
    // the graph walk would visit. Each such emitter is expected to guard its
    // own body via a memo key so multiple calls are idempotent.
    for (const block of graph.blocks.values()) {
        const e = loadedEmitters.get(block.className);
        if (e?.sideEffect) {
            e.emit(block, "", e.stage ?? "fragment", state, ctx);
        }
    }

    return {
        vertexWgsl: composeStage(state, "vertex"),
        fragmentWgsl: composeStage(state, "fragment"),
        state,
    };
}

function composeStage(state: NodeBuildState, stage: Stage): string {
    // Helpers are emitted at module scope by the pipeline builder, NOT inside main.
    // composeStage returns only the statements that belong inside the entry point.
    const s = stageOf(state, stage);
    return s.body.join("\n");
}
