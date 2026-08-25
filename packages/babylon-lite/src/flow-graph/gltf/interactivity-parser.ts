// ⚠️ SPEC-VOLATILE — KHR_interactivity is an UNRATIFIED glTF draft. Quarantined
// here so the runtime core never changes when the spec churns. Mirrored against
// Babylon.js commit 8f728b23ea (2026-06-24). Re-sync against BJS PR #18455
// ("KHR_interactivity rework") when it lands.
// See docs/lite/architecture/51-flow-graph.md → glTF KHR_interactivity Loader.
//
// interactivity-parser: walks a `glTF.extensions.KHR_interactivity` graph object
// (types → declarations → variables → nodes/values/flows) and produces a
// spec-agnostic `FgGraph` plus the list of JSON pointers to resolve into
// accessors. Mirrors BJS `interactivityGraphParser.ts`, collapsed for Lite's
// pre-resolved-accessor model (see declaration-mapper.ts).
//
// Unknown ops FAIL LOUDLY (structured error listing every offending op) so a
// KHR_interactivity asset can't silently render a broken interaction.

import { fgInt } from "../custom-types/fg-integer.js";
import { fgMatrix2D, fgMatrix3D } from "../custom-types/fg-matrix.js";
import type { Mat4 } from "../../math/types.js";
import { getBlockDef } from "../block-registry.js";
import type { FgBlock, FgDataSocket, FgGraph, FgSignalSocket, FgValue } from "../types.js";
import { FgType } from "../types.js";
import { DEFAULT_FLOW_SOCKET, DEFAULT_VALUE_SOCKET, getOpMapping, type FgOpMapping } from "./declaration-mapper.js";

// ─── glTF wire-format shapes (loose; spec-volatile) ──────────────────────────

interface GltfValueEntry {
    /** Literal payload. Numeric for scalar/vector literals; a single-element
     *  STRING array (`["/materials/4/"]`) for `ref`-typed pointer values. */
    value?: (number | string)[];
    type?: number;
    node?: number;
    socket?: string;
}
interface GltfFlowEntry {
    node: number;
    socket?: string;
}
interface GltfNode {
    declaration: number;
    configuration?: Record<string, { value: unknown[] }>;
    values?: Record<string, GltfValueEntry>;
    flows?: Record<string, GltfFlowEntry>;
}
export interface GltfInteractivityGraph {
    types?: { signature: string }[];
    declarations?: { op: string; extension?: string }[];
    variables?: { type: number; value?: number[] }[];
    events?: unknown[];
    nodes?: GltfNode[];
}

/** Result of parsing one interactivity graph. */
export interface FgParseResult {
    readonly graph: FgGraph;
    /** Resolved JSON-pointer strings the loader must turn into accessors
     *  (keyed identically in `block.config.accessor`). */
    readonly pointers: readonly string[];
}

const SIGNATURE_TO_FGTYPE: Readonly<Record<string, FgType>> = {
    bool: FgType.Boolean,
    int: FgType.Integer,
    float: FgType.Number,
    float2: FgType.Vector2,
    float3: FgType.Vector3,
    float4: FgType.Vector4,
    float2x2: FgType.Matrix2D,
    float3x3: FgType.Matrix3D,
    float4x4: FgType.Matrix,
};

/** Coerce a glTF flat value array into an `FgValue` of the given type. */
function arrayToFgValue(arr: number[] | undefined, type: FgType): FgValue {
    const a = arr ?? [];
    switch (type) {
        case FgType.Boolean:
            return !!a[0];
        case FgType.Integer:
            return fgInt(a[0] ?? 0);
        case FgType.Number:
            return a[0] ?? 0;
        case FgType.Vector2:
            return { x: a[0] ?? 0, y: a[1] ?? 0 };
        case FgType.Vector3:
            return { x: a[0] ?? 0, y: a[1] ?? 0, z: a[2] ?? 0 };
        case FgType.Vector4:
        case FgType.Quaternion:
            return { x: a[0] ?? 0, y: a[1] ?? 0, z: a[2] ?? 0, w: a[3] ?? 0 };
        case FgType.Matrix2D:
            // glTF matrix literals are column-major — stored directly (no transpose).
            return fgMatrix2D(a);
        case FgType.Matrix3D:
            return fgMatrix3D(a);
        case FgType.Matrix: {
            const m = new Float32Array(16);
            for (let i = 0; i < 16; i++) {
                m[i] = a[i] ?? 0;
            }
            return m as unknown as Mat4;
        }
        default:
            return a[0] ?? 0;
    }
}

/** Extract the trailing integer index from a glTF `ref` path string
 *  (`"/materials/4/"` → `"4"`). Returns `null` when there's no trailing index. */
function refPathIndex(ref: string): string | null {
    const m = /(\d+)\/?$/.exec(ref);
    return m ? m[1]! : null;
}

/** Resolve a pointer template against a node's value sockets.
 *
 *  Two spec forms are supported (mirrors BJS `FlowGraphPathConverterComponent`
 *  + the newer relative-pointer draft targeted by PR #18455):
 *  1. **Absolute + `{seg}` placeholders** — each `{seg}` reads `node.values[seg]`.
 *     A `ref`-typed value (`["/materials/4/"]`) contributes its trailing index
 *     (`4`); a numeric value is substituted directly.
 *  2. **Relative** — when the substituted result doesn't start with `/`, prepend
 *     the path of a `ref`-typed value socket that wasn't consumed as a
 *     placeholder (e.g. `nodeRef` = `["/nodes/22/"]`).
 *
 *  Returns `null` if a placeholder segment is missing/non-literal, or a relative
 *  template has no ref prefix to anchor it. */
function resolvePointerTemplate(template: string, node: GltfNode): string | null {
    let ok = true;
    const usedSegments = new Set<string>();
    const resolved = template.replace(/\{(\w+)\}/g, (_m, seg: string) => {
        const entry = node.values?.[seg];
        const literal = entry?.value?.[0];
        if (literal === undefined || entry?.node !== undefined) {
            ok = false;
            return _m;
        }
        usedSegments.add(seg);
        if (typeof literal === "string") {
            const idx = refPathIndex(literal);
            if (idx === null) {
                ok = false;
                return _m;
            }
            return idx;
        }
        return String(literal);
    });
    if (!ok) {
        return null;
    }
    if (resolved.startsWith("/")) {
        return resolved;
    }
    // Relative pointer: anchor it on an unused ref-typed value socket.
    for (const [key, entry] of Object.entries(node.values ?? {})) {
        if (usedSegments.has(key) || entry.node !== undefined) {
            continue;
        }
        const v = entry.value?.[0];
        if (typeof v === "string" && v.startsWith("/")) {
            return v.replace(/\/$/, "") + "/" + resolved;
        }
    }
    return null;
}

/** Compute a node's per-flow-key → Lite signal-output-name map (handles the
 *  dynamic sequence renaming and switch-style integer-key prefixing). */
function flowOutputName(mapping: FgOpMapping, flowKeys: string[], key: string): string {
    if (mapping.dynamicSequence) {
        return `out_${flowKeys.indexOf(key)}`;
    }
    // Switch-style: glTF flow keys are raw case integers; prefix with "out_"
    // except for "default" which passes through unchanged.
    if (mapping.switchOutputs && key !== "default") {
        return `out_${key}`;
    }
    return mapping.flowOutputs?.[key] ?? key;
}

/** Parse one KHR_interactivity graph object into an `FgGraph` + pointer list. */
export async function parseInteractivityGraph(json: GltfInteractivityGraph): Promise<FgParseResult> {
    const types = (json.types ?? []).map((t) => SIGNATURE_TO_FGTYPE[t.signature] ?? FgType.Any);
    const declarations = json.declarations ?? [];
    const nodes = json.nodes ?? [];

    // Resolve the mapping for every node first, collecting unknown ops.
    const mappings: FgOpMapping[] = [];
    const unsupported: string[] = [];
    for (const node of nodes) {
        const decl = declarations[node.declaration];
        const mapping = decl ? getOpMapping(decl.op, decl.extension) : null;
        if (!mapping) {
            const label = decl ? `${decl.extension ? decl.extension + ":" : ""}${decl.op}` : `declaration#${node.declaration}`;
            if (!unsupported.includes(label)) {
                unsupported.push(label);
            }
        }
        mappings.push(mapping as FgOpMapping);
    }
    if (unsupported.length > 0) {
        throw new Error(`KHR_interactivity: unsupported op(s): ${unsupported.join(", ")}`);
    }

    // Graph variables (keyed by index, mirroring BJS getVariableName(i)).
    const variables: Record<string, { type: FgType; value: FgValue }> = {};
    (json.variables ?? []).forEach((v, i) => {
        const t = types[v.type] ?? FgType.Any;
        variables[String(i)] = { type: t, value: arrayToFgValue(v.value, t) };
    });

    // Pass 1: instantiate each block's socket shape from its def + config.
    const blocks: FgBlock[] = [];
    const pointers: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const mapping = mappings[i]!;
        const config: Record<string, unknown> = {};

        if (mapping.dynamicSequence) {
            config.outputSignalCount = Object.keys(node.flows ?? {}).length;
        }
        if (mapping.variableConfigKey) {
            const idx = (node.configuration?.[mapping.variableConfigKey]?.value?.[0] as number) ?? 0;
            config.variable = String(idx);
        }
        if (mapping.nodeConfigKey) {
            config[mapping.nodeConfigKey] = node.configuration?.[mapping.nodeConfigKey]?.value?.[0] as number;
        }
        // ⚠️ SPEC-VOLATILE: configKeys/configArrayKeys — re-sync against BJS PR #18455.
        if (mapping.configKeys) {
            for (const [gltfKey, liteName] of Object.entries(mapping.configKeys)) {
                const raw = node.configuration?.[gltfKey]?.value;
                if (raw !== undefined) {
                    config[liteName] = raw[0]; // scalar: first element only
                }
            }
        }
        if (mapping.configArrayKeys) {
            for (const [gltfKey, liteName] of Object.entries(mapping.configArrayKeys)) {
                const raw = node.configuration?.[gltfKey]?.value;
                if (raw !== undefined) {
                    config[liteName] = raw; // array: full value array
                }
            }
        }
        if (mapping.pointer) {
            const template = node.configuration?.pointer?.value?.[0] as string | undefined;
            const resolved = template ? resolvePointerTemplate(template, node) : null;
            if (resolved === null) {
                throw new Error(`KHR_interactivity: node ${i} has an unresolvable pointer ${JSON.stringify(template)} (dynamic segments are not yet supported)`);
            }
            config.accessor = resolved;
            if (!pointers.includes(resolved)) {
                pointers.push(resolved);
            }
        }

        const def = await getBlockDef(mapping.block)!();
        const shape = def.build(config);
        blocks.push({
            id: `node_${i}`,
            type: mapping.block,
            config,
            dataIn: [...(shape.dataIn ?? [])],
            dataOut: shape.dataOut ?? [],
            signalIn: shape.signalIn ?? [],
            signalOut: (shape.signalOut ?? []).map((s) => ({ name: s.name, targets: [] as { blockId: string; socket: string }[] })),
            event: shape.event,
        });
    }

    // Pass 2: wire data sources (values) and signal targets (flows).
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const mapping = mappings[i]!;
        const block = blocks[i]!;

        // Data inputs.
        for (const [gltfKey, entry] of Object.entries(node.values ?? {})) {
            if (mapping.pointer && gltfKey !== "value") {
                continue; // pointer segment — consumed by accessor resolution
            }
            const inputName = mapping.valueInputs?.[gltfKey] ?? gltfKey;
            const socket = block.dataIn.find((d) => d.name === inputName) as (FgDataSocket & { source?: unknown; defaultValue?: FgValue }) | undefined;
            if (!socket) {
                continue;
            }
            if (entry.node !== undefined) {
                const producer = mappings[entry.node]!;
                const gltfSocket = entry.socket ?? DEFAULT_VALUE_SOCKET;
                socket.source = { blockId: `node_${entry.node}`, socket: producer.outputValues?.[gltfSocket] ?? gltfSocket };
            } else {
                const raw = (entry.value ?? []) as number[];
                const transform = mapping.valueTransform?.[gltfKey];
                const arr = transform ? transform(raw) : raw;
                socket.defaultValue = arrayToFgValue(arr, types[entry.type ?? -1] ?? socket.type);
            }
        }

        // Signal outputs (flows).
        const flowKeys = Object.keys(node.flows ?? {});
        for (const key of flowKeys) {
            const flow = node.flows![key]!;
            const outName = flowOutputName(mapping, flowKeys, key);
            const out = block.signalOut.find((s) => s.name === outName) as FgSignalSocket | undefined;
            if (!out) {
                continue;
            }
            (out.targets as { blockId: string; socket: string }[]).push({ blockId: `node_${flow.node}`, socket: flow.socket ?? DEFAULT_FLOW_SOCKET });
        }
    }

    const byId: Record<string, number> = {};
    blocks.forEach((b, i) => (byId[b.id] = i));
    return { graph: { blocks, byId, variables }, pointers };
}
