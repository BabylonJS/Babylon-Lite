import type { SceneContext } from "../scene/scene-core.js";
import type { FgBlockDef } from "./block-def.js";
import { getBlockDef } from "./block-registry.js";
import type { FgWiring } from "./context.js";
import { fgInt, isFgInt } from "./custom-types/fg-integer.js";
import { fgMatrix2D, fgMatrix3D, isFgMatrix2D, isFgMatrix3D } from "./custom-types/fg-matrix.js";
import { addFlowGraph } from "./scene-flow-graph.js";
import type { FgRuntime } from "./runtime.js";
import type { FgBlock, FgDataSocket, FgGraph, FgValue } from "./types.js";
import { FgType } from "./types.js";

export interface SerializedEditorConnection {
    uniqueId: string;
    name: string;
    connectedPointIds?: string[];
    defaultValue?: unknown;
    richType?: { typeName?: string; defaultValue?: unknown };
}

export interface SerializedEditorBlock {
    className: string;
    uniqueId: string;
    config?: Record<string, unknown>;
    dataInputs?: SerializedEditorConnection[];
    dataOutputs?: SerializedEditorConnection[];
    signalInputs?: SerializedEditorConnection[];
    signalOutputs?: SerializedEditorConnection[];
}

export interface SerializedEditorContext {
    /** @internal Serialized Babylon.js field name. */
    _userVariables?: Record<string, unknown>;
    /** @internal Serialized Babylon.js field name. */
    _variableTypes?: Record<string, string>;
    /** @internal Serialized Babylon.js field name. */
    _connectionValues?: Record<string, unknown>;
}

export interface SerializedEditorGraph {
    allBlocks: SerializedEditorBlock[];
    executionContexts?: SerializedEditorContext[];
    rightHanded?: boolean;
}

export interface ParsedEditorFlowGraphs {
    readonly graphs: readonly FgGraph[];
    readonly rightHanded: readonly boolean[];
    readonly activeGraphIndex: number;
    readonly dispatchEventsSynchronously: boolean;
}

export interface EditorValueParseOptions {
    /** Resolve serialized scene/asset references that Lite cannot resolve itself. */
    readonly resolveReference?: (value: Readonly<Record<string, unknown>>) => unknown;
}

const CLASS_ALIASES: Readonly<Record<string, string>> = {
    Fract: "Fraction",
    IsInf: "IsInfinity",
    ASin: "Asin",
    ACos: "Acos",
    ATan: "Atan",
    ATan2: "Atan2",
    ASinh: "Asinh",
    ACosh: "Acosh",
    ATanh: "Atanh",
    MathSmoothStep: "SmoothStep",
    IsNan: "IsNaN",
    Exp: "Exponential",
    ConditionalData: "Conditional",
    Transform: "TransformVector",
};

function editorClassToBlockType(className: string): string {
    const shortName = className.replace(/^FlowGraph/, "").replace(/Block$/, "");
    return CLASS_ALIASES[shortName] ?? shortName;
}

function typeFromName(name: string | undefined): FgType {
    switch (name) {
        case "number":
        case "Number":
            return FgType.Number;
        case "boolean":
        case "Boolean":
            return FgType.Boolean;
        case "string":
        case "String":
            return FgType.String;
        case "FlowGraphInteger":
            return FgType.Integer;
        case "Vector2":
            return FgType.Vector2;
        case "Vector3":
            return FgType.Vector3;
        case "Vector4":
            return FgType.Vector4;
        case "Quaternion":
            return FgType.Quaternion;
        case "Matrix":
            return FgType.Matrix;
        case "Matrix2D":
            return FgType.Matrix2D;
        case "Matrix3D":
            return FgType.Matrix3D;
        case "Color3":
            return FgType.Color3;
        case "Color4":
            return FgType.Color4;
        case "ref":
            return FgType.Reference;
        default:
            return FgType.Any;
    }
}

function parseEditorValue(value: unknown, options: EditorValueParseOptions): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const descriptor = value as Record<string, unknown>;
    const className = (descriptor.type ?? descriptor.className) as string | undefined;
    const raw = descriptor.value;
    const array = Array.isArray(raw) ? raw.map(Number) : [];
    switch (typeFromName(className)) {
        case FgType.Number:
        case FgType.Boolean:
        case FgType.String:
        case FgType.Reference:
            return Array.isArray(raw) ? raw[0] : raw;
        case FgType.Integer:
            return fgInt(Number(raw));
        case FgType.Vector2:
            return { x: array[0] ?? 0, y: array[1] ?? 0 };
        case FgType.Vector3:
            return { x: array[0] ?? 0, y: array[1] ?? 0, z: array[2] ?? 0 };
        case FgType.Vector4:
        case FgType.Quaternion:
            return { x: array[0] ?? 0, y: array[1] ?? 0, z: array[2] ?? 0, w: array[3] ?? 0 };
        case FgType.Color3:
            return { r: array[0] ?? 0, g: array[1] ?? 0, b: array[2] ?? 0 };
        case FgType.Color4:
            return { r: array[0] ?? 0, g: array[1] ?? 0, b: array[2] ?? 0, a: array[3] ?? 1 };
        case FgType.Matrix2D:
            return fgMatrix2D(array);
        case FgType.Matrix3D:
            return fgMatrix3D(array);
        case FgType.Matrix:
            return new Float32Array(array);
        default:
            if ("className" in descriptor || "id" in descriptor || "name" in descriptor) {
                return options.resolveReference?.(descriptor) ?? descriptor;
            }
            return "value" in descriptor ? raw : descriptor;
    }
}

function inferType(value: unknown): FgType {
    if (typeof value === "number") {
        return FgType.Number;
    }
    if (typeof value === "boolean") {
        return FgType.Boolean;
    }
    if (typeof value === "string") {
        return FgType.String;
    }
    if (isFgInt(value)) {
        return FgType.Integer;
    }
    if (isFgMatrix2D(value)) {
        return FgType.Matrix2D;
    }
    if (isFgMatrix3D(value)) {
        return FgType.Matrix3D;
    }
    if (value instanceof Float32Array && value.length === 16) {
        return FgType.Matrix;
    }
    if (value && typeof value === "object") {
        if ("w" in value) {
            return FgType.Vector4;
        }
        if ("z" in value) {
            return FgType.Vector3;
        }
        if ("x" in value && "y" in value) {
            return FgType.Vector2;
        }
        if ("r" in value && "a" in value) {
            return FgType.Color4;
        }
        if ("r" in value) {
            return FgType.Color3;
        }
    }
    return FgType.Any;
}

function parseConfig(serialized: SerializedEditorBlock, dispatchEventsSynchronously: boolean, options: EditorValueParseOptions): Record<string, unknown> {
    const config = Object.fromEntries(Object.entries(serialized.config ?? {}).map(([key, value]) => [key, parseEditorValue(value, options)]));
    if (serialized.className === "FlowGraphSequenceBlock" && config.outputSignalCount === undefined) {
        config.outputSignalCount = serialized.signalOutputs?.length ?? 1;
    }
    if (serialized.className === "FlowGraphSendCustomEventBlock" || serialized.className === "FlowGraphReceiveCustomEventBlock") {
        const rawEventData = config.eventData;
        const eventData = Array.isArray(rawEventData)
            ? Object.fromEntries(
                  rawEventData
                      .filter((entry): entry is { id: string; type?: string; value?: unknown; eventData?: boolean } => !!entry && typeof entry === "object" && "id" in entry)
                      .filter((entry) => entry.eventData !== false)
                      .map((entry) => [entry.id, entry])
              )
            : (rawEventData as Record<string, { type?: string; value?: unknown }> | undefined);
        if (eventData) {
            config.valueNames = Object.keys(eventData);
            config.valueTypes = Object.values(eventData).map((entry) => typeFromName(entry.type));
            config.valueDefaults = Object.fromEntries(Object.entries(eventData).map(([name, entry]) => [name, parseEditorValue(entry.value, options)]));
        }
        config.dispatchEventsSynchronously = dispatchEventsSynchronously;
    }
    return config;
}

function mergeDataSockets(
    shape: readonly FgDataSocket[],
    serialized: readonly SerializedEditorConnection[],
    context: SerializedEditorContext,
    options: EditorValueParseOptions
): FgDataSocket[] {
    const byName = new Map(shape.map((socket) => [socket.name, socket]));
    const connections: readonly SerializedEditorConnection[] = serialized.length > 0 ? serialized : shape.map((socket) => ({ uniqueId: "", name: socket.name }));
    return connections.map((connection) => {
        const declared = byName.get(connection.name);
        const contextValue = connection.uniqueId ? context._connectionValues?.[connection.uniqueId] : undefined;
        const rawDefault = contextValue !== undefined ? contextValue : (connection.defaultValue ?? connection.richType?.defaultValue);
        const defaultValue = rawDefault === undefined ? declared?.defaultValue : (parseEditorValue(rawDefault, options) as FgValue);
        return {
            name: connection.name,
            type: declared?.type ?? typeFromName(connection.richType?.typeName),
            defaultValue,
        };
    });
}

async function parseEditorGraph(
    serialized: SerializedEditorGraph,
    context: SerializedEditorContext,
    dispatchEventsSynchronously: boolean,
    options: EditorValueParseOptions
): Promise<FgGraph> {
    const blocks: FgBlock[] = [];
    const defs = new Map<string, FgBlockDef>();
    const serializedBlocks = serialized.allBlocks ?? [];

    for (const source of serializedBlocks) {
        const type = editorClassToBlockType(source.className);
        const factory = getBlockDef(type);
        if (!factory) {
            throw new Error(`Flow Graph Editor: unsupported block class ${JSON.stringify(source.className)}`);
        }
        const def = defs.get(type) ?? (await factory());
        defs.set(type, def);
        const config = parseConfig(source, dispatchEventsSynchronously, options);
        if (source.className === "FlowGraphGetPropertyBlock" || source.className === "FlowGraphSetPropertyBlock") {
            config.editorPropertyAccess = true;
        }
        const shape = def.build(config);
        const signalInputNames = source.signalInputs?.length ? source.signalInputs.map((socket) => socket.name) : (shape.signalIn ?? []).map((socket) => socket.name);
        const signalOutputNames = source.signalOutputs?.length ? source.signalOutputs.map((socket) => socket.name) : (shape.signalOut ?? []).map((socket) => socket.name);
        blocks.push({
            id: source.uniqueId,
            type,
            config,
            dataIn: mergeDataSockets(shape.dataIn ?? [], source.dataInputs ?? [], context, options),
            dataOut: mergeDataSockets(shape.dataOut ?? [], source.dataOutputs ?? [], {}, options),
            signalIn: signalInputNames.map((name) => ({ name, targets: [] })),
            signalOut: signalOutputNames.map((name) => ({ name, targets: [] })),
            event: shape.event,
        });
    }

    const dataOutputs = new Map<string, { blockId: string; socket: string }>();
    const dataInputs = new Map<string, { blockId: string; socket: string }>();
    const signalInputs = new Map<string, { blockId: string; socket: string }>();
    const signalOutputs = new Map<string, { blockId: string; socket: string }>();
    serializedBlocks.forEach((block) => {
        block.dataOutputs?.forEach((connection) => dataOutputs.set(connection.uniqueId, { blockId: block.uniqueId, socket: connection.name }));
        block.dataInputs?.forEach((connection) => dataInputs.set(connection.uniqueId, { blockId: block.uniqueId, socket: connection.name }));
        block.signalInputs?.forEach((connection) => signalInputs.set(connection.uniqueId, { blockId: block.uniqueId, socket: connection.name }));
        block.signalOutputs?.forEach((connection) => signalOutputs.set(connection.uniqueId, { blockId: block.uniqueId, socket: connection.name }));
    });

    const connectData = (target: { blockId: string; socket: string }, producer: { blockId: string; socket: string }): void => {
        const input = blocks.find((block) => block.id === target.blockId)?.dataIn.find((socket) => socket.name === target.socket);
        if (input && !input.source) {
            input.source = producer;
        }
    };
    const connectSignal = (producer: { blockId: string; socket: string }, target: { blockId: string; socket: string }): void => {
        const output = blocks.find((block) => block.id === producer.blockId)?.signalOut.find((socket) => socket.name === producer.socket);
        if (output && !output.targets.some((entry) => entry.blockId === target.blockId && entry.socket === target.socket)) {
            (output.targets as { blockId: string; socket: string }[]).push(target);
        }
    };

    serializedBlocks.forEach((source, index) => {
        const block = blocks[index]!;
        source.dataInputs?.forEach((connection) => {
            const producer = connection.connectedPointIds?.map((id) => dataOutputs.get(id)).find(Boolean);
            if (producer) {
                connectData({ blockId: block.id, socket: connection.name }, producer);
            }
        });
        source.dataOutputs?.forEach((connection) => {
            for (const targetId of connection.connectedPointIds ?? []) {
                const target = dataInputs.get(targetId);
                if (target) {
                    connectData(target, { blockId: block.id, socket: connection.name });
                }
            }
        });
        source.signalOutputs?.forEach((connection) => {
            for (const targetId of connection.connectedPointIds ?? []) {
                const target = signalInputs.get(targetId);
                if (target) {
                    connectSignal({ blockId: block.id, socket: connection.name }, target);
                }
            }
        });
        source.signalInputs?.forEach((connection) => {
            for (const producerId of connection.connectedPointIds ?? []) {
                const producer = signalOutputs.get(producerId);
                if (producer) {
                    connectSignal(producer, { blockId: block.id, socket: connection.name });
                }
            }
        });
    });

    const variables: Record<string, { type: FgType; value: FgValue }> = {};
    for (const [name, rawValue] of Object.entries(context._userVariables ?? {})) {
        const value = parseEditorValue(rawValue, options) as FgValue;
        const annotatedType = typeFromName(context._variableTypes?.[name]);
        variables[name] = { type: annotatedType === FgType.Any ? inferType(value) : annotatedType, value };
    }
    const byId: Record<string, number> = {};
    blocks.forEach((block, index) => (byId[block.id] = index));
    return { blocks, byId, variables };
}

/** Parse coordinator JSON or legacy single-graph JSON saved by Babylon.js's
 * Flow Graph Editor. Each serialized execution context becomes an independent
 * Lite graph instance so context-local values remain isolated. */
export async function parseFlowGraphEditorJson(serialized: unknown, options: EditorValueParseOptions = {}): Promise<ParsedEditorFlowGraphs> {
    if (!serialized || typeof serialized !== "object") {
        throw new Error("Flow Graph Editor: expected a serialized object");
    }
    const root = serialized as Record<string, unknown>;
    const serializedGraphs = Array.isArray(root._flowGraphs) ? (root._flowGraphs as SerializedEditorGraph[]) : [root as unknown as SerializedEditorGraph];
    const dispatchEventsSynchronously = root.dispatchEventsSynchronously !== false;
    const sourceActiveIndex = typeof root.activeGraphIndex === "number" ? root.activeGraphIndex : 0;
    const graphs: FgGraph[] = [];
    const rightHanded: boolean[] = [];
    let activeGraphIndex = 0;

    for (let sourceIndex = 0; sourceIndex < serializedGraphs.length; sourceIndex++) {
        const graph = serializedGraphs[sourceIndex]!;
        if (!Array.isArray(graph.allBlocks)) {
            throw new Error(`Flow Graph Editor: graph ${sourceIndex} has no allBlocks array`);
        }
        if (sourceIndex === sourceActiveIndex) {
            activeGraphIndex = graphs.length;
        }
        const contexts = graph.executionContexts?.length ? graph.executionContexts : [{}];
        for (const context of contexts) {
            graphs.push(await parseEditorGraph(graph, context, dispatchEventsSynchronously, options));
            rightHanded.push(graph.rightHanded ?? false);
        }
    }
    return { graphs, rightHanded, activeGraphIndex, dispatchEventsSynchronously };
}

/** Parse and attach editor JSON to a scene, sharing the scene event bus across
 * every graph/context just like a Babylon.js FlowGraphCoordinator. */
export async function addFlowGraphEditorJson(scene: SceneContext, serialized: unknown, wiring: FgWiring = {}, options: EditorValueParseOptions = {}): Promise<FgRuntime[]> {
    const parsed = await parseFlowGraphEditorJson(serialized, options);
    const runtimes: FgRuntime[] = [];
    for (let index = 0; index < parsed.graphs.length; index++) {
        runtimes.push(await addFlowGraph(scene, parsed.graphs[index]!, wiring, { rightHanded: parsed.rightHanded[index] }));
    }
    return runtimes;
}
