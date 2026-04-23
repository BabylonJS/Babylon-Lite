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
 *  This parser is network-agnostic: `parseSnippetPayload` accepts a JSON string,
 *  and `fetchSnippet` is a thin wrapper for tests to stub.
 */

import type { NodeBlock, NodeConnection, NodeConnectionRef, NodeGraph, NodeValueType } from "./node-types.js";

// ─── Snippet fetch ───────────────────────────────────────────────────

const DEFAULT_SNIPPET_SERVER = "https://snippet.babylonjs.com";

/** Fetch a snippet and return its parsed `nodeMaterial` JSON root. */
export async function fetchSnippetSource(snippetId: string, server: string = DEFAULT_SNIPPET_SERVER): Promise<unknown> {
    // Accept both "AT7YY5" and "AT7YY5#6". The snippet server uses `/{id}/{version}`.
    const [id, version] = snippetId.split("#");
    const url = version ? `${server}/${id}/${version}` : `${server}/${id}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`NodeMaterial: snippet fetch failed (${resp.status}) for ${url}`);
    }
    const outer = (await resp.json()) as { jsonPayload?: string };
    if (!outer.jsonPayload) {
        throw new Error(`NodeMaterial: snippet "${snippetId}" has no jsonPayload`);
    }
    const inner = JSON.parse(outer.jsonPayload) as { nodeMaterial?: string };
    if (!inner.nodeMaterial) {
        throw new Error(`NodeMaterial: snippet "${snippetId}" has no nodeMaterial`);
    }
    return JSON.parse(inner.nodeMaterial);
}

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
            const source: NodeConnectionRef | null =
                typeof ri.targetBlockId === "number" && typeof ri.targetConnectionName === "string" ? { blockId: ri.targetBlockId, outputName: ri.targetConnectionName } : null;
            inputs.set(ri.name, {
                name: ri.name,
                type: "vec4f", // refined at emit time based on emitter; parser cannot infer type
                source,
            });
        }

        const outputs = new Map<string, NodeValueType>();
        for (const ro of rb.outputs ?? []) {
            outputs.set(ro.name, "vec4f");
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
        if (mode === 0 || mode === undefined) {
            if (b.name) {
                namedInputs.set(b.name, b.id);
            }
        }
    }

    return { blocks, namedInputs };
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
