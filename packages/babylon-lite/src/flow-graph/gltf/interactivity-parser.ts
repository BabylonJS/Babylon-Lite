// SPEC-VOLATILE — KHR_interactivity release candidate. Quarantined here so the
// runtime core never changes when the spec churns. Mirrored against Khronos
// commit fdb8ce0e2e0b7ecf3466f8dacb9f1385257b8276 and Babylon.js commit
// bd3837eed0890e590fdd6aeb6cc4d605e4eb8ac7.
// See docs/lite/architecture/51-flow-graph.md → glTF KHR_interactivity Loader.
//
// interactivity-parser: walks a `glTF.extensions.KHR_interactivity` graph object
// (types → declarations → variables → nodes/values/flows) and produces a
// spec-agnostic `FgGraph` plus the list of JSON pointers to resolve into
// accessors. Mirrors BJS `interactivityGraphParser.ts`, collapsed for Lite's
// pre-resolved-accessor model (see declaration-mapper.ts).
//
// Unsupported operations are represented as typed no-ops, as required by the
// release-candidate specification. Structural errors still reject this graph.

import { fgInt } from "../custom-types/fg-integer.js";
import { fgMatrix2D, fgMatrix3D } from "../custom-types/fg-matrix.js";
import type { Mat4 } from "../../math/types.js";
import { getBlockDef } from "../block-registry.js";
import type { FgBlock, FgDataSocket, FgGraph, FgSignalSocket, FgValue } from "../types.js";
import { FgType } from "../types.js";
import { DEFAULT_FLOW_SOCKET, DEFAULT_VALUE_SOCKET, getOpMapping, type FgOpMapping } from "./declaration-mapper.js";
import { parseJsonPointerTemplate, substituteJsonPointerTemplate } from "./json-pointer-template.js";

// ─── glTF wire-format shapes (loose; spec-volatile) ──────────────────────────

interface GltfValueEntry {
    /** Literal payload. Numeric for scalar/vector literals; a single-element
     *  STRING array (`["/materials/4/"]`) for `ref`-typed pointer values. */
    value?: unknown[];
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
interface GltfSocketDeclaration {
    type: number;
}
interface GltfDeclaration {
    op: string;
    extension?: string;
    inputValueSockets?: Record<string, GltfSocketDeclaration>;
    outputValueSockets?: Record<string, GltfSocketDeclaration>;
    inputFlowSockets?: Record<string, unknown>;
}
interface GltfEvent {
    id?: string;
    values?: Record<string, { type: number; value?: unknown[] }>;
}
export interface GltfInteractivityGraph {
    types?: { signature: string }[];
    declarations?: GltfDeclaration[];
    variables?: { type: number; value?: unknown[] }[];
    events?: GltfEvent[];
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
    ref: FgType.Reference,
};

/** Coerce a glTF flat value array into an `FgValue` of the given type. */
function arrayToFgValue(arr: unknown[] | undefined, type: FgType): FgValue {
    const missingNumber = arr === undefined ? NaN : 0;
    const numberAt = (index: number): number => {
        const value = arr?.[index];
        return typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : missingNumber;
    };
    switch (type) {
        case FgType.Boolean:
            return !!arr?.[0];
        case FgType.Integer:
            return fgInt(numberAt(0) || 0);
        case FgType.Number:
            return numberAt(0);
        case FgType.Reference:
        case FgType.String:
            return typeof arr?.[0] === "string" ? arr[0] : "";
        case FgType.Vector2:
            return { x: numberAt(0), y: numberAt(1) };
        case FgType.Vector3:
            return { x: numberAt(0), y: numberAt(1), z: numberAt(2) };
        case FgType.Vector4:
        case FgType.Quaternion:
            return { x: numberAt(0), y: numberAt(1), z: numberAt(2), w: numberAt(3) };
        case FgType.Matrix2D:
            return fgMatrix2D(Array.from({ length: 4 }, (_, i) => numberAt(i)));
        case FgType.Matrix3D:
            return fgMatrix3D(Array.from({ length: 9 }, (_, i) => numberAt(i)));
        case FgType.Matrix: {
            const m = new Float32Array(16);
            for (let i = 0; i < 16; i++) {
                m[i] = numberAt(i);
            }
            return m as unknown as Mat4;
        }
        default:
            return arr?.[0] as FgValue;
    }
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
    const signatures = (json.types ?? []).map((type) => type.signature);
    if (new Set(signatures).size !== signatures.length) {
        throw new Error("KHR_interactivity: duplicate type signatures");
    }
    const types = signatures.map((signature) => {
        const type = SIGNATURE_TO_FGTYPE[signature];
        if (!type) {
            throw new Error(`KHR_interactivity: unsupported type signature ${JSON.stringify(signature)}`);
        }
        return type;
    });
    const declarations = json.declarations ?? [];
    const nodes = json.nodes ?? [];

    // Unsupported declarations are retained as typed no-op nodes.
    const mappings: (FgOpMapping | null)[] = [];
    for (const node of nodes) {
        const decl = declarations[node.declaration];
        const mapping = decl ? getOpMapping(decl.op, decl.extension) : null;
        if (!decl) {
            throw new Error(`KHR_interactivity: node references missing declaration #${node.declaration}`);
        }
        mappings.push(mapping);
    }

    // Graph variables (keyed by index, mirroring BJS getVariableName(i)).
    const variables: Record<string, { type: FgType; value: FgValue }> = {};
    (json.variables ?? []).forEach((v, i) => {
        const t = types[v.type] ?? FgType.Any;
        if (!types[v.type]) {
            throw new Error(`KHR_interactivity: variable ${i} references missing type #${v.type}`);
        }
        variables[String(i)] = { type: t, value: arrayToFgValue(v.value, t) };
    });

    let anonymousEventIndex = 0;
    const events = (json.events ?? []).map((event, index) => {
        const values = Object.entries(event.values ?? {}).map(([name, value]) => {
            const type = types[value.type];
            if (!type) {
                throw new Error(`KHR_interactivity: event ${index} value ${JSON.stringify(name)} references missing type #${value.type}`);
            }
            return { name, type, value: arrayToFgValue(value.value, type) };
        });
        return { id: event.id ?? `internalEvent_${anonymousEventIndex++}`, values };
    });

    // Pass 1: instantiate each block's socket shape from its def + config.
    const blocks: FgBlock[] = [];
    const pointers: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const mapping = mappings[i];
        const declaration = declarations[node.declaration]!;
        const config: Record<string, unknown> = {};

        if (!mapping) {
            config.inputs = Object.entries(declaration.inputValueSockets ?? {}).map(([name, socket]) => ({ name, type: types[socket.type] ?? FgType.Any }));
            config.outputs = Object.entries(declaration.outputValueSockets ?? {}).map(([name, socket]) => {
                const type = types[socket.type] ?? FgType.Any;
                return { name, type, defaultValue: arrayToFgValue(undefined, type) };
            });
            config.signalInputs = Object.keys(declaration.inputFlowSockets ?? { in: {} });
        }

        if (mapping?.dynamicSequence) {
            config.outputSignalCount = Object.keys(node.flows ?? {}).length;
        }
        if (mapping?.variableConfigKey) {
            const idx = node.configuration?.[mapping.variableConfigKey]?.value?.[0];
            if (typeof idx !== "number" || !json.variables?.[idx]) {
                throw new Error(`KHR_interactivity: ${declaration.op} node ${i} references invalid variable #${String(idx)}`);
            }
            config.variable = String(idx);
        }
        if (mapping?.nodeConfigKey) {
            config[mapping.nodeConfigKey] = node.configuration?.[mapping.nodeConfigKey]?.value?.[0] as number;
        }
        // SPEC-VOLATILE: generic configuration translation.
        if (mapping?.configKeys) {
            for (const [gltfKey, liteName] of Object.entries(mapping.configKeys)) {
                const raw = node.configuration?.[gltfKey]?.value;
                if (raw !== undefined) {
                    config[liteName] = raw[0]; // scalar: first element only
                }
            }
        }
        if (mapping?.configArrayKeys) {
            for (const [gltfKey, liteName] of Object.entries(mapping.configArrayKeys)) {
                const raw = node.configuration?.[gltfKey]?.value;
                if (raw !== undefined) {
                    config[liteName] = raw; // array: full value array
                }
            }
        }
        if (declaration.op === "variable/set") {
            const current = node.configuration?.variables?.value;
            const legacy = node.configuration?.variable?.value?.[0];
            const indices = current ?? (typeof legacy === "number" ? [legacy] : []);
            if (indices.length === 0 || indices.some((index) => typeof index !== "number" || !json.variables?.[index]) || new Set(indices).size !== indices.length) {
                throw new Error(`KHR_interactivity: variable/set node ${i} has invalid variable indices`);
            }
            const variableIndices = indices as number[];
            for (const index of variableIndices) {
                const input = node.values?.[String(index)];
                if (!input) {
                    throw new Error(`KHR_interactivity: variable/set node ${i} is missing input for variable #${index}`);
                }
                const expectedType = types[json.variables![index]!.type];
                if (input.type !== undefined && types[input.type] !== expectedType) {
                    throw new Error(`KHR_interactivity: variable/set node ${i} input for variable #${index} has the wrong type`);
                }
            }
            config.variables = variableIndices;
            config.variableTypes = Object.fromEntries(variableIndices.map((index) => [String(index), types[json.variables![index]!.type] ?? FgType.Any]));
        }
        if (mapping?.pointer) {
            const template = node.configuration?.pointer?.value?.[0] as string | undefined;
            if (!template) {
                throw new Error(`KHR_interactivity: node ${i} is missing its pointer configuration`);
            }
            let parsedTemplate;
            try {
                parsedTemplate = parseJsonPointerTemplate(template);
            } catch (error) {
                throw new Error(`KHR_interactivity: node ${i} has an invalid pointer template: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            for (const parameter of parsedTemplate.parameters) {
                const input = node.values?.[parameter.id];
                if (!input) {
                    throw new Error(`KHR_interactivity: node ${i} is missing pointer parameter ${JSON.stringify(parameter.id)}`);
                }
                const actualType = input.type === undefined ? undefined : types[input.type];
                const expectedType = parameter.kind === "integer" ? FgType.Integer : FgType.Reference;
                const legacyNumericReference = parameter.kind === "reference" && (actualType === FgType.Integer || actualType === FgType.Number);
                if (actualType !== undefined && actualType !== expectedType && !legacyNumericReference) {
                    throw new Error(`KHR_interactivity: node ${i} pointer parameter ${JSON.stringify(parameter.id)} has the wrong type`);
                }
            }
            const resolved = substituteJsonPointerTemplate(parsedTemplate, (parameter) => {
                const input = node.values?.[parameter.id];
                return input?.node === undefined ? input?.value?.[0] : undefined;
            });
            const segments = parsedTemplate.parameters.map((parameter) => parameter.id);
            config.pointerParameterIds = segments;
            const reserved = declaration.op === "pointer/set" ? ["value"] : declaration.op === "pointer/interpolate" ? ["value", "duration", "p1", "p2"] : [];
            if (segments.some((parameter) => reserved.includes(parameter))) {
                throw new Error(`KHR_interactivity: ${declaration.op} node ${i} uses a reserved pointer parameter`);
            }
            if (resolved === null) {
                config.pointerTemplate = template;
                config.pointerSegments = segments;
            } else {
                config.accessor = resolved;
                if (!pointers.includes(resolved)) {
                    pointers.push(resolved);
                }
            }
            const configuredType = node.configuration?.type?.value?.[0];
            const inferredType = declaration.op === "pointer/set" ? node.values?.value?.type : undefined;
            const typeIndex = typeof configuredType === "number" ? configuredType : inferredType;
            if (typeIndex !== undefined) {
                if (!types[typeIndex]) {
                    throw new Error(`KHR_interactivity: ${declaration.op} node ${i} references invalid type #${String(typeIndex)}`);
                }
                config.type = types[typeIndex];
            }
        }

        if (declaration.op === "event/send" || declaration.op === "event/receive") {
            const eventIndex = node.configuration?.event?.value?.[0];
            if (typeof eventIndex !== "number" || !events[eventIndex]) {
                throw new Error(`KHR_interactivity: node ${i} references invalid event #${String(eventIndex)}`);
            }
            const event = events[eventIndex]!;
            config.eventId = event.id;
            config.valueNames = event.values.map((value) => value.name);
            config.valueTypes = event.values.map((value) => value.type);
            config.valueDefaults = Object.fromEntries(event.values.map((value) => [value.name, value.value]));
            config.dispatchEventsSynchronously = false;
        }

        if (declaration.op === "variable/interpolate" || declaration.op === "pointer/interpolate") {
            for (const socket of ["value", "duration", "p1", "p2"]) {
                if (!node.values?.[socket]) {
                    throw new Error(`KHR_interactivity: ${declaration.op} node ${i} is missing required ${socket} input`);
                }
            }
            let interpolationType: FgType | undefined;
            if (declaration.op === "variable/interpolate") {
                const variableIndex = node.configuration?.variable?.value?.[0];
                if (typeof variableIndex !== "number" || !json.variables?.[variableIndex]) {
                    throw new Error(`KHR_interactivity: variable/interpolate node ${i} references invalid variable #${String(variableIndex)}`);
                }
                interpolationType = types[json.variables[variableIndex]!.type];
                config.variable = String(variableIndex);
                if (config.useSlerp === true && interpolationType !== FgType.Vector4) {
                    throw new Error(`KHR_interactivity: variable/interpolate node ${i} can only use slerp with float4`);
                }
            } else {
                const typeIndex = node.configuration?.type?.value?.[0];
                if (typeof typeIndex !== "number" || !types[typeIndex]) {
                    throw new Error(`KHR_interactivity: pointer/interpolate node ${i} references invalid type #${String(typeIndex)}`);
                }
                interpolationType = types[typeIndex];
            }
            if (interpolationType === FgType.Boolean || interpolationType === FgType.Integer) {
                throw new Error(`KHR_interactivity: ${declaration.op} node ${i} cannot interpolate ${interpolationType}`);
            }
            config.type = interpolationType;
        }

        const blockType = mapping?.block ?? "NoOp";
        const def = await getBlockDef(blockType)!();
        const shape = def.build(config);
        blocks.push({
            id: `node_${i}`,
            type: blockType,
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
        const mapping = mappings[i];
        const block = blocks[i]!;

        // Data inputs.
        for (const [gltfKey, entry] of Object.entries(node.values ?? {})) {
            const inputName = mapping?.valueInputs?.[gltfKey] ?? gltfKey;
            const socket = block.dataIn.find((d) => d.name === inputName) as (FgDataSocket & { source?: unknown; defaultValue?: FgValue }) | undefined;
            if (!socket) {
                continue;
            }
            if (entry.node !== undefined) {
                if (!blocks[entry.node]) {
                    throw new Error(`KHR_interactivity: node ${i} references missing producer node #${entry.node}`);
                }
                const producer = mappings[entry.node];
                const gltfSocket = entry.socket ?? DEFAULT_VALUE_SOCKET;
                socket.source = {
                    blockId: `node_${entry.node}`,
                    socket: producer?.outputValues?.[gltfSocket] ?? gltfSocket,
                    scale: mapping?.connectedValueScale?.[gltfKey],
                };
            } else {
                const raw = entry.value;
                const transform = mapping?.valueTransform?.[gltfKey];
                const arr = transform && raw ? transform(raw as number[]) : raw;
                socket.defaultValue = arrayToFgValue(arr, types[entry.type ?? -1] ?? socket.type);
            }
        }

        // Signal outputs (flows).
        const flowKeys = Object.keys(node.flows ?? {});
        for (const key of flowKeys) {
            const flow = node.flows![key]!;
            if (!blocks[flow.node]) {
                throw new Error(`KHR_interactivity: node ${i} flow ${JSON.stringify(key)} targets missing node #${flow.node}`);
            }
            if (!mapping) {
                continue;
            }
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
