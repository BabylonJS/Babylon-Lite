/** Node Material parser — BJS snippet JSON → internal NodeGraph.
 *
 *  BJS serializes node materials as a flat block list:
 *    {
 *      blocks: [
 *        {
 *          customType: "BABYLON.InputBlock",
 *          id: <uniqueId>,
 *          name, comments,
 *          inputs:  [{ name, inputName, targetBlockId, targetConnectionName, ... }],
 *          outputs: [{ name }],
 *          ...per-class serialized fields (value, mode, type, ...)
 *        },
 *        ...
 *      ],
 *      outputNodes: [id, id, ...],   // FragmentOutputBlock + VertexOutputBlock ids
 *      editorData: { ... }           // UI locations; irrelevant to rendering
 *    }
 *
 *  Snippet server wraps this JSON once more:
 *    { id, version, jsonPayload: "<stringified { nodeMaterial: "<stringified JSON above>" }>" }
 *
 *  This parser is network-agnostic; snippet fetching lives in node-snippet.ts.
 */

import type { NodeBlock, NodeConnection, NodeConnectionRef, NodeGraph } from "./node-types.js";

// ─── Block-level JSON shape ──────────────────────────────────────────

interface RawInput {
    name: string;
    displayName?: string;
    inputName?: string;
    targetBlockId?: number;
    targetConnectionName?: string;
}

interface RawOutput {
    name: string;
    displayName?: string;
}

interface RawBlock {
    customType: string;
    id: number;
    name: string;
    comments?: string;
    inputs?: RawInput[];
    outputs?: RawOutput[];
    [extra: string]: unknown;
}

interface RawSource {
    blocks: RawBlock[];
    outputNodes?: number[];
}

interface RawWithAlpha {
    alphaMode?: number;
    _needAlphaBlending?: boolean;
    forceAlphaBlending?: boolean;
    backFaceCulling?: boolean;
}

// ─── Parse ───────────────────────────────────────────────────────────

/** Parse a deserialized NME JSON root into the internal NodeGraph model. */
export function parseNodeMaterialSource(source: unknown): NodeGraph {
    const raw = source as RawSource;
    if (!raw || !Array.isArray(raw.blocks)) {
        throw new Error("NodeMaterial: invalid source — expected `.blocks` array");
    }

    const blocks = new Map<number, NodeBlock>();

    for (const rb of raw.blocks) {
        if (typeof rb.id !== "number") {
            throw new Error(`NodeMaterial: block missing numeric id (name=${rb.name})`);
        }
        const className = stripBabylonPrefix(rb.customType);

        const inputs = new Map<string, NodeConnection>();
        for (const ri of rb.inputs ?? []) {
            // BJS serializes some composite input names with trailing whitespace
            // (e.g. "xyz ", "rgb ") to avoid collisions with same-named outputs. Normalize.
            const inName = (ri.name ?? "").trim();
            const outName = typeof ri.targetConnectionName === "string" ? ri.targetConnectionName.trim() : undefined;
            const source: NodeConnectionRef | null =
                typeof ri.targetBlockId === "number" && typeof outName === "string" ? { blockId: ri.targetBlockId, outputName: outName } : null;
            inputs.set(inName, {
                name: inName,
                source,
            });
        }

        const outputs = new Set<string>();
        for (const ro of rb.outputs ?? []) {
            outputs.add((ro.name ?? "").trim());
        }

        blocks.set(rb.id, {
            id: rb.id,
            className,
            name: rb.name,
            inputs,
            outputs,
            serialized: rb as unknown as Record<string, unknown>,
        });
    }

    // Named overridable inputs — any InputBlock in uniform mode is overridable.
    // BJS uses _mode: NodeMaterialBlockConnectionPointMode.Uniform (value === 0).
    const namedInputs = new Map<string, number>();
    for (const b of blocks.values()) {
        if (b.className !== "InputBlock") {
            continue;
        }
        const mode = (b.serialized["mode"] ?? b.serialized["_mode"]) as number | undefined;
        // 0 = Uniform, 1 = Attribute, 2 = Varying. Only Uniform is user-overridable.
        // System-value InputBlocks (mode 0 with a `systemValue`) are scene-provided and NOT overridable.
        if (mode === 0 || mode === undefined) {
            if (typeof b.serialized["systemValue"] === "number") {
                continue;
            }
            if (b.name) {
                namedInputs.set(b.name, b.id);
            }
        }
    }

    // Alpha mode + blending determination.
    // Priority: forceAlphaBlending > explicit _needAlphaBlending > graph-derived.
    const rawAlpha = raw as RawWithAlpha;
    const alphaMode: number = typeof rawAlpha.alphaMode === "number" ? rawAlpha.alphaMode : 0;
    let needsAlphaBlending: boolean;
    if (rawAlpha.forceAlphaBlending === true) {
        needsAlphaBlending = true;
    } else if (typeof rawAlpha._needAlphaBlending === "boolean") {
        needsAlphaBlending = rawAlpha._needAlphaBlending;
    } else {
        // Derive from graph: blending is needed when FragmentOutputBlock's `a`
        // input is connected AND alphaMode > 0 (non-disabled).
        const fragOut = findBlockByClassName({ blocks, namedInputs, alphaMode, needsAlphaBlending: false, backFaceCulling: true }, "FragmentOutputBlock");
        const aConn = fragOut?.inputs.get("a");
        needsAlphaBlending = alphaMode > 0 && !!aConn?.source;
    }

    return { blocks, namedInputs, alphaMode, needsAlphaBlending, backFaceCulling: rawAlpha.backFaceCulling !== false };
}

function stripBabylonPrefix(customType: string): string {
    return customType.startsWith("BABYLON.") ? customType.slice("BABYLON.".length) : customType;
}

// ─── Topological sort ───────────────────────────────────────────────

/** Topologically sort block ids in dependency order (producers before consumers).
 *  Throws on cycles. Starts from `roots` (typically the VertexOutput +
 *  FragmentOutput block ids) and only includes blocks transitively reached. */
export function topoSort(graph: NodeGraph, roots: readonly number[]): number[] {
    const order: number[] = [];
    const state = new Map<number, 0 | 1 | 2>(); // 0=unseen, 1=on-stack, 2=done

    const visit = (id: number, path: number[]): void => {
        const s = state.get(id) ?? 0;
        if (s === 2) {
            return;
        }
        if (s === 1) {
            throw new Error(`NodeMaterial: cycle detected through block ${id} (${path.join(" -> ")})`);
        }
        state.set(id, 1);
        const block = graph.blocks.get(id);
        if (!block) {
            throw new Error(`NodeMaterial: dangling reference to block ${id}`);
        }
        for (const input of block.inputs.values()) {
            if (input.source) {
                visit(input.source.blockId, [...path, id]);
            }
        }
        state.set(id, 2);
        order.push(id);
    };

    for (const r of roots) {
        visit(r, [r]);
    }
    return order;
}

/** Locate a block by className (returns the first match, or null). */
export function findBlockByClassName(graph: NodeGraph, className: string): NodeBlock | null {
    for (const b of graph.blocks.values()) {
        if (b.className === className) {
            return b;
        }
    }
    return null;
}
