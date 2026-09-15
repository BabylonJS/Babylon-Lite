import { unsupported } from "../error.js";

const KHR_INTERACTIVITY_UNSUPPORTED =
    "KHR_interactivity depends on Babylon.js FlowGraph block, connection, context, serialization, and glTF-reference models. Lite's flow-graph runtime uses a different graph model, so a stable cross-model adapter requires a broader loader/runtime design.";

export type KHRInteractivitySignature = "bool" | "float" | "float2" | "float3" | "float4" | "float2x2" | "float3x3" | "float4x4" | "int" | "ref" | "custom";

export interface IKHRInteractivityNode {
    declaration: number;
    values?: Record<string, IKHRInteractivityVariable | IKHRInteractivityOutputSocketReference>;
    flows?: Record<string, IKHRInteractivityOutputFlow>;
    configuration?: Record<string, IKHRInteractivityConfiguration>;
}

export interface IKHRInteractivityGraph {
    name?: string;
    types?: IKHRInteractivityType[];
    variables?: IKHRInteractivityVariable[];
    events?: IKHRInteractivityEvent[];
    declarations?: IKHRInteractivityDeclaration[];
    nodes?: IKHRInteractivityNode[];
}

export interface IKHRInteractivityDeclaration {
    op: string;
    extension?: string;
    outputValueSockets?: Record<string, { type: number }>;
    inputValueSockets?: Record<string, { type: number }>;
}

export interface IKHRInteractivityType {
    signature: KHRInteractivitySignature;
}

export interface IKHRInteractivityVariable {
    value?: Array<boolean | number | string>;
    type: number;
}

export interface IKHRInteractivityEvent {
    id?: string;
    values?: Record<string, IKHRInteractivityVariable>;
}

export interface IKHRInteractivityOutputSocketReference {
    node: number;
    socket?: string;
    type?: number;
}

export interface IKHRInteractivityOutputFlow {
    node: number;
    socket?: string;
}

export interface IKHRInteractivityConfiguration {
    value?: Array<boolean | number | string>;
}

export interface IGLTF {
    asset: {
        version: string;
    };
    nodes?: unknown[];
}

export interface ISerializedFlowGraphConnection {
    uniqueId: string;
    name: string;
    // eslint-disable-next-line babylon-lite/underscore-requires-internal -- Public Babylon.js field.
    _connectionType: number;
    connectedPointIds: string[];
    defaultValue?: unknown;
}

export interface ISerializedFlowGraphBlock {
    className: string;
    type: string;
    config: unknown;
    uniqueId: string;
    dataInputs: ISerializedFlowGraphConnection[];
    dataOutputs: ISerializedFlowGraphConnection[];
    metadata: unknown;
    signalInputs: ISerializedFlowGraphConnection[];
    signalOutputs: ISerializedFlowGraphConnection[];
}

export type ISerializedFlowGraphContext = {
    uniqueId: string;
    name?: string;
    enableLogging?: boolean;
} & Record<"_userVariables" | "_connectionValues", Record<string, unknown>> &
    Partial<Record<"_variableTypes", Record<string, string>>> &
    Partial<Record<"_assetsContext", Record<string, unknown>>>;

export interface ISerializedFlowGraph {
    name?: string;
    uniqueId?: string;
    executionContexts: ISerializedFlowGraphContext[];
    allBlocks: ISerializedFlowGraphBlock[];
    rightHanded?: boolean;
}

type CompatibleCallback<TArgs extends unknown[], TResult> = {
    bivarianceHack(...args: TArgs): TResult;
}["bivarianceHack"];

export interface IGLTFToFlowGraphMappingObject {
    name: string;
    compatibilityOnly?: boolean;
    gltfType?: string;
    flowGraphType?: string;
    // Babylon.js intentionally exposes `any` here so explicitly typed transformers remain assignable under strictFunctionTypes.
    dataTransformer?: (data: any, parser: InteractivityGraphToFlowGraphParser) => any;
    isArray?: boolean;
    inOptions?: boolean;
    isVariable?: boolean;
    toBlock?: string;
    defaultValue?: unknown;
    convertConnectedTimeToFrames?: boolean;
    configurationType?: "bool" | "int" | "int[]" | "string";
    validationOnly?: boolean;
    required?: boolean;
    indexSource?: "types" | "variables" | "events" | "nodes" | "assetNodes";
    minItems?: number;
    generatesInputValueSockets?: boolean;
    generatesCaseInputValueSockets?: boolean;
    pointerTemplate?: boolean;
    invalidUsesDefault?: boolean;
    allowedSignatures?: readonly KHRInteractivitySignature[];
    typeSourceInput?: string;
    minimum?: number;
    maximum?: number;
    generatesInputFlowSockets?: boolean;
    generatesOutputFlowSockets?: boolean;
    configurationGroup?: string;
    uniqueValues?: boolean;
    debugLogTemplate?: boolean;
}

export interface IGLTFToFlowGraphMapping {
    blocks: string[];
    declarationSchema?: {
        inputValueSockets: Record<string, KHRInteractivitySignature>;
        outputValueSockets: Record<string, KHRInteractivitySignature>;
    };
    inputs?: {
        values?: Record<string, IGLTFToFlowGraphMappingObject>;
        flows?: Record<string, IGLTFToFlowGraphMappingObject>;
    };
    outputs?: {
        values?: Record<string, IGLTFToFlowGraphMappingObject>;
        flows?: Record<string, IGLTFToFlowGraphMappingObject>;
    };
    configuration?: Record<string, IGLTFToFlowGraphMappingObject>;
    typeToTypeMapping?: Record<string, IGLTFToFlowGraphMappingObject>;
    interBlockConnectors?: Array<{
        input: string;
        output: string;
        inputBlockIndex: number;
        outputBlockIndex: number;
        isVariable?: boolean;
    }>;
    validation?: CompatibleCallback<[gltfBlock: IKHRInteractivityNode, interactivityGraph: IKHRInteractivityGraph, glTFObject?: IGLTF], { valid: boolean; error?: string }>;
    extraProcessor?: CompatibleCallback<
        [
            gltfBlock: IKHRInteractivityNode,
            declaration: IKHRInteractivityDeclaration,
            mapping: IGLTFToFlowGraphMapping,
            parser: InteractivityGraphToFlowGraphParser,
            serializedObjects: ISerializedFlowGraphBlock[],
            context: ISerializedFlowGraphContext,
            globalGLTF?: IGLTF,
        ],
        ISerializedFlowGraphBlock[]
    >;
}

export interface IDebugLogTemplateParseResult {
    valid: boolean;
    sockets: string[];
}

export function ParseDebugLogTemplate(_message: string): IDebugLogTemplateParseResult {
    return unsupported("GLTF2.ParseDebugLogTemplate", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function getMappingForFullOperationName(_operation: string): IGLTFToFlowGraphMapping | undefined {
    return unsupported("GLTF2.getMappingForFullOperationName", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function getMappingForDeclaration(_declaration: unknown, _returnNoOpIfNotAvailable = true): IGLTFToFlowGraphMapping | undefined {
    return unsupported("GLTF2.getMappingForDeclaration", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function getNoOpMappingForDeclaration(_declaration: unknown): IGLTFToFlowGraphMapping {
    return unsupported("GLTF2.getNoOpMappingForDeclaration", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function addNewInteractivityFlowGraphMapping(_key: string, _extension: string, _mapping: IGLTFToFlowGraphMapping): void {
    unsupported("GLTF2.addNewInteractivityFlowGraphMapping", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function getAllSupportedNativeNodeTypes(): string[] {
    return unsupported("GLTF2.getAllSupportedNativeNodeTypes", KHR_INTERACTIVITY_UNSUPPORTED);
}

export type KHRInteractivityFlowGraphType =
    | "any"
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "FlowGraphInteger"
    | "Vector2"
    | "Vector3"
    | "Vector4"
    | "Quaternion"
    | "Matrix"
    | "Matrix2D"
    | "Matrix3D"
    | "Color3"
    | "Color4";

export interface IKHRInteractivityTypeMapping {
    length: number;
    flowGraphType: KHRInteractivityFlowGraphType;
    elementType: "number" | "boolean" | "string" | "any";
}

export const gltfTypeToBabylonType: Readonly<Record<string, IKHRInteractivityTypeMapping>> = {
    float: { length: 1, flowGraphType: "number", elementType: "number" },
    bool: { length: 1, flowGraphType: "boolean", elementType: "boolean" },
    float2: { length: 2, flowGraphType: "Vector2", elementType: "number" },
    float3: { length: 3, flowGraphType: "Vector3", elementType: "number" },
    float4: { length: 4, flowGraphType: "Vector4", elementType: "number" },
    float4x4: { length: 16, flowGraphType: "Matrix", elementType: "number" },
    float2x2: { length: 4, flowGraphType: "Matrix2D", elementType: "number" },
    float3x3: { length: 9, flowGraphType: "Matrix3D", elementType: "number" },
    int: { length: 1, flowGraphType: "FlowGraphInteger", elementType: "number" },
    ref: { length: 1, flowGraphType: "string", elementType: "string" },
    custom: { length: 0, flowGraphType: "any", elementType: "any" },
};

export interface IFlowGraphEventReferenceBlockConfiguration {
    eventKey?: string;
    [key: string]: unknown;
}

export class FlowGraphEventReferenceBlock {
    public readonly config: IFlowGraphEventReferenceBlockConfiguration;

    public constructor(config: IFlowGraphEventReferenceBlockConfiguration) {
        this.config = config;
        unsupported("GLTF2.FlowGraphEventReferenceBlock", KHR_INTERACTIVITY_UNSUPPORTED);
    }
}

export interface IFlowGraphGLTFDataProviderBlockConfiguration {
    glTF?: unknown;
    [key: string]: unknown;
}

export class FlowGraphGLTFDataProvider {
    public constructor(_config: IFlowGraphGLTFDataProviderBlockConfiguration = {}) {
        unsupported("GLTF2.FlowGraphGLTFDataProvider", KHR_INTERACTIVITY_UNSUPPORTED);
    }
}

export function GetInteractivityObjectReference(_context: unknown, _value: object | undefined): string {
    return unsupported("GLTF2.GetInteractivityObjectReference", KHR_INTERACTIVITY_UNSUPPORTED);
}

export class FlowGraphObjectReferenceBlock {
    public constructor(_config: Record<string, unknown> = {}) {
        unsupported("GLTF2.FlowGraphObjectReferenceBlock", KHR_INTERACTIVITY_UNSUPPORTED);
    }
}

export interface IFlowGraphUnsupportedInteractivitySocket {
    name: string;
    type?: string;
    signature?: string;
}

export interface IFlowGraphUnsupportedInteractivityBlockConfiguration {
    operation: string;
    inputValueSockets: IFlowGraphUnsupportedInteractivitySocket[];
    outputValueSockets: IFlowGraphUnsupportedInteractivitySocket[];
    inputFlowSockets: string[];
    outputFlowSockets: string[];
    [key: string]: unknown;
}

export class FlowGraphUnsupportedInteractivityBlock {
    public readonly config: IFlowGraphUnsupportedInteractivityBlockConfiguration;

    public constructor(config: IFlowGraphUnsupportedInteractivityBlockConfiguration) {
        this.config = config;
        unsupported("GLTF2.FlowGraphUnsupportedInteractivityBlock", KHR_INTERACTIVITY_UNSUPPORTED);
    }
}

export const KHR_INTERACTIVITY_SPECIFICATION_COMMIT = "f798712c5685bc9223a628140fba707db8889300";

export type KHRInteractivityDeclarationSupport = "core" | "extension" | "unsupported-extension" | "unknown-core";

export interface IKHRInteractivityDiagnostic {
    path: string;
    message: string;
    severity: "error" | "warning";
}

export interface IKHRInteractivityDeclarationModel {
    index: number;
    operation: string;
    support: KHRInteractivityDeclarationSupport;
    source: unknown;
}

export interface IKHRInteractivityGraphModel {
    index: number;
    path: string;
    name: string;
    source: unknown;
    effectiveSource: unknown;
    declarations: IKHRInteractivityDeclarationModel[];
    diagnostics: IKHRInteractivityDiagnostic[];
    valid: boolean;
}

export interface IKHRInteractivityDocument {
    specificationCommit: string;
    source: unknown;
    defaultGraphIndex: number;
    graphs: IKHRInteractivityGraphModel[];
    diagnostics: IKHRInteractivityDiagnostic[];
}

export function CloneKHRInteractivityGraph(_graph: unknown): never {
    return unsupported("GLTF2.CloneKHRInteractivityGraph", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function CreateEffectiveKHRInteractivityGraph(_graph: unknown, _declarations: readonly IKHRInteractivityDeclarationModel[], _assetNodeCount?: number): never {
    return unsupported("GLTF2.CreateEffectiveKHRInteractivityGraph", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function CreateKHRInteractivityGraphModel(_graph: unknown, _index = 0, _supportedExtensions?: ReadonlySet<string>, _assetNodeCount?: number): IKHRInteractivityGraphModel {
    return unsupported("GLTF2.CreateKHRInteractivityGraphModel", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function CreateKHRInteractivityDocument(_extension: unknown, _supportedExtensions?: ReadonlySet<string>, _assetNodeCount?: number): IKHRInteractivityDocument {
    return unsupported("GLTF2.CreateKHRInteractivityDocument", KHR_INTERACTIVITY_UNSUPPORTED);
}

export interface InteractivityEvent {
    eventId: string;
    eventData?: Array<{
        eventData: boolean;
        id: string;
        type: string;
        value?: unknown;
    }>;
}

export class InteractivityGraphToFlowGraphParser {
    /** @internal Upstream parser timing state; the parser itself is unsupported. */
    public _animationTargetFps: number;

    public constructor(
        _interactivityGraph: unknown,
        _gltf: unknown,
        animationTargetFps = 60,
        _graphIndex = 0,
        _supportedExtensions?: ReadonlySet<string>,
        _declarationModels?: readonly IKHRInteractivityDeclarationModel[]
    ) {
        this._animationTargetFps = animationTargetFps;
        unsupported("GLTF2.InteractivityGraphToFlowGraphParser", KHR_INTERACTIVITY_UNSUPPORTED);
    }

    public getVariableName(_index: number): string {
        return unsupported("GLTF2.InteractivityGraphToFlowGraphParser.getVariableName", KHR_INTERACTIVITY_UNSUPPORTED);
    }

    public get arrays(): {
        types: IKHRInteractivityTypeMapping[];
        mappings: Array<{
            flowGraphMapping: IGLTFToFlowGraphMapping;
            fullOperationName: string;
            declaration: IKHRInteractivityDeclarationModel;
        }>;
        staticVariables: Array<{ type: KHRInteractivityFlowGraphType; value: any[] }>;
        events: InteractivityEvent[];
        nodes: Array<{ blocks: ISerializedFlowGraphBlock[]; fullOperationName: string }>;
    } {
        return unsupported("GLTF2.InteractivityGraphToFlowGraphParser.arrays", KHR_INTERACTIVITY_UNSUPPORTED);
    }

    public serializeToFlowGraph(): ISerializedFlowGraph {
        return unsupported("GLTF2.InteractivityGraphToFlowGraphParser.serializeToFlowGraph", KHR_INTERACTIVITY_UNSUPPORTED);
    }
}

export type InteractivityNodeState = "hoverable" | "selectable";

export function InitializeInteractivityNodeState(_nodes: readonly unknown[], _state: InteractivityNodeState, _getAuthoredState: (node: unknown) => boolean | undefined): void {
    unsupported("GLTF2.InitializeInteractivityNodeState", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function GetInteractivityNodeState(_node: unknown, _state: InteractivityNodeState): boolean {
    return unsupported("GLTF2.GetInteractivityNodeState", KHR_INTERACTIVITY_UNSUPPORTED);
}

export function SetInteractivityNodeState(_node: unknown, _state: InteractivityNodeState, _value: boolean): void {
    unsupported("GLTF2.SetInteractivityNodeState", KHR_INTERACTIVITY_UNSUPPORTED);
}
