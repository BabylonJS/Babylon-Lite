// Flow-graph core data types — pure state, no classes, no attached methods.
// A graph is plain data describing topology + config only; behaviour lives in
// FgBlockDef records (block-def.ts) and standalone runtime functions
// (runtime.ts). See docs/lite/architecture/51-flow-graph.md.

import type { Color3, Color4, Mat4, Quat, Vec2, Vec3, Vec4 } from "../math/types.js";
export type { Vec2 } from "../math/types.js";
import type { FgInteger } from "./custom-types/fg-integer.js";
import type { FgMatrix2D, FgMatrix3D } from "./custom-types/fg-matrix.js";

/** A value that can flow along a data edge. */
export type FgValue = number | boolean | string | Vec2 | Vec3 | Vec4 | Quat | Mat4 | FgInteger | FgMatrix2D | FgMatrix3D | Color3 | Color4 | null | undefined;

/** Type tags. `const enum` → fully erased at build, zero runtime cost.
 *  String values intentionally match the glTF / BJS `flowGraphType` identifiers
 *  so the declaration mapper can pass them through unchanged. */
export const enum FgType {
    Any = "any",
    Number = "number",
    Boolean = "boolean",
    String = "string",
    Integer = "FlowGraphInteger",
    Vector2 = "Vector2",
    Vector3 = "Vector3",
    Vector4 = "Vector4",
    Quaternion = "Quaternion",
    Matrix = "Matrix",
    Matrix2D = "Matrix2D",
    Matrix3D = "Matrix3D",
    Color3 = "Color3",
    Color4 = "Color4",
    /** Opaque host reference. KHR uses canonical JSON Pointer strings; "" is null. */
    Reference = "ref",
}

/** A data input/output port — plain data. */
export interface FgDataSocket {
    readonly name: string;
    readonly type: FgType;
    /** Wired source (for inputs): producing block id + its output socket name. */
    source?: { blockId: string; socket: string; scale?: number };
    /** Literal fallback used when `source` is undefined. */
    defaultValue?: FgValue;
}

/** A control-flow (signal) port — plain data. Push model. */
export interface FgSignalSocket {
    readonly name: string;
    /** Wired targets (for outputs): consuming block id + its input signal name. */
    readonly targets: { blockId: string; socket: string }[];
}

/** A node instance — PURE DATA describing topology + config only. */
export interface FgBlock {
    readonly id: string;
    /** `FgBlockType` value or a `"module/Name"` custom identifier. */
    readonly type: string;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly dataIn: readonly FgDataSocket[];
    readonly dataOut: readonly FgDataSocket[];
    readonly signalIn: readonly FgSignalSocket[];
    readonly signalOut: readonly FgSignalSocket[];
    /** Declared by event blocks; which bus event activates them. */
    readonly event?: FgEventType;
}

/** A parsed graph — pure data. */
export interface FgGraph {
    readonly blocks: readonly FgBlock[];
    /** id → block index, for O(1) edge resolution (built by the parser/builder). */
    readonly byId: Readonly<Record<string, number>>;
    /** Declared graph variables: name → type + initial value. */
    readonly variables: Readonly<Record<string, { type: FgType; value: FgValue }>>;
}

/** Event channels an event block can subscribe to. `const enum` → erased. */
export const enum FgEventType {
    /** Fired once when the graph starts (scene ready). */
    Start = "start",
    /** Fired every frame with `{ deltaMs, deltaTime }`. */
    Tick = "tick",
    /** Custom events sent between graphs; payload carries `eventName` + values. */
    CustomEvent = "customEvent",
    /** Pointer events forwarded by the picking/input layer. */
    Pointer = "pointer",
    /** Keyboard events forwarded by the input layer. */
    Key = "key",
}
