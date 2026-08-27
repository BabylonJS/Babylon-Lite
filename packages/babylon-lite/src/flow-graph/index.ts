// Public surface of the flow-graph subsystem. Pure data + standalone functions.
// Re-exported from the package root (../index.ts).

// Core data types
export type { FgBlock, FgDataSocket, FgGraph, FgSignalSocket, FgValue, Vec2 } from "./types.js";
export { FgEventType, FgType } from "./types.js";

// Behaviour definitions + block-type names
export type { FgBlockDef, FgBlockShape } from "./block-def.js";
export { FgBlockType } from "./block-type.js";

// Execution context & environment
export type { FgAccessor, FgCapabilities, FgContext, FgEnv, FgPendingTask, FgWiring, LoadedFlowGraph } from "./context.js";

// Event bus
export type { FgEventBus, FgEventHandler, FgEventPayload } from "./event-bus.js";
export { clearFgEventBus, createFgEventBus, flushFgEvents, pumpFgEvent, queueFgEvent, stopFgEventPropagation, subscribeFgEvent } from "./event-bus.js";

// Rich-type pure functions
export { animationTypeForFgType, coerceValue, defaultForType, FgAnimationValueType } from "./rich-type.js";

// Custom types
export type { FgInteger } from "./custom-types/fg-integer.js";
export { fgInt, isFgInt } from "./custom-types/fg-integer.js";
export type { FgMatrix2D, FgMatrix3D } from "./custom-types/fg-matrix.js";
export { fgMatrix2D, fgMatrix3D, isFgMatrix2D, isFgMatrix3D } from "./custom-types/fg-matrix.js";

// Block registry
export { getBlockDef } from "./block-registry.js";

// Scene attachment
export { attachFlowGraph, detachFlowGraph, runFlowGraphs, addFlowGraph, dispatchFlowGraphEvent, flowGraphBus, flowGraphRuntimes } from "./scene-flow-graph.js";
export { dispatchFlowGraphPointerPick, enableFlowGraphPointerPicking } from "./scene-flow-graph-pointer.js";

export type { FgNodeSpec, FgVariableSpec } from "./graph-builder.js";
export { buildFgGraph } from "./graph-builder.js";

// Babylon.js Flow Graph Editor serialization
export type {
    EditorValueParseOptions,
    ParsedEditorFlowGraphs,
    SerializedEditorBlock,
    SerializedEditorConnection,
    SerializedEditorContext,
    SerializedEditorGraph,
} from "./editor-serialization.js";
export { addFlowGraphEditorJson, parseFlowGraphEditorJson } from "./editor-serialization.js";

// Runtime functions + FgRuntime
export type { FgRuntime } from "./runtime.js";
export {
    activateSignal,
    addPending,
    cancelPendingForBlock,
    compactPending,
    createFgContext,
    createFgEnv,
    createFgRuntime,
    disposeFlowGraph,
    getDataValue,
    getExecVar,
    setDataValue,
    setExecVar,
    startFlowGraph,
    stillPending,
    tickFlowGraph,
} from "./runtime.js";
