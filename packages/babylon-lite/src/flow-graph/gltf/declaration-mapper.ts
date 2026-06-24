// ⚠️ SPEC-VOLATILE — KHR_interactivity is an UNRATIFIED glTF draft. Quarantined
// here so the runtime core never changes when the spec churns. Mirrored against
// Babylon.js commit 8f728b23ea (2026-06-24). Re-sync against BJS PR #18455
// ("KHR_interactivity rework") when it lands.
// See docs/lite/architecture/42-flow-graph.md → glTF KHR_interactivity Loader.
//
// declaration-mapper: maps each glTF interactivity `op` string to the Lite block
// it instantiates, plus the socket/config translation. Mirrors BJS
// `declarationMapper.ts`, but COLLAPSED: BJS expands pointer/animation ops into
// multiple blocks + inter-block connectors (JsonPointerParser, ArrayIndex,
// GLTFDataProvider). Lite pre-resolves pointers to accessors and animations to
// caps in the loader, so each op maps to a SINGLE block.

import { FgBlockType } from "../block-type.js";

/** Default glTF value-output socket name (used when a reference omits `socket`). */
export const DEFAULT_VALUE_SOCKET = "value";
/** Default glTF flow-input socket name (used when a flow omits `socket`). */
export const DEFAULT_FLOW_SOCKET = "in";
/** Frames-per-second used to convert animation seconds → frames (glTF default). */
export const ANIMATION_FPS = 60;

/** Lite-side mapping descriptor for one glTF interactivity op. */
export interface FgOpMapping {
    /** The Lite block this op instantiates. */
    readonly block: FgBlockType;
    /** glTF value-INPUT socket name → Lite data-input name. Unlisted inputs that
     *  are NOT pointer segments are passed through by their glTF name. */
    readonly valueInputs?: Readonly<Record<string, string>>;
    /** Per-input numeric transform applied to a literal value array before
     *  coercion (e.g. animation seconds → frames). Keyed by glTF input name. */
    readonly valueTransform?: Readonly<Record<string, (arr: number[]) => number[]>>;
    /** glTF value-OUTPUT socket name → Lite data-output name (for data references
     *  that read this block). Default output `value` passes through. */
    readonly outputValues?: Readonly<Record<string, string>>;
    /** glTF flow-OUTPUT socket name → Lite signal-output name. */
    readonly flowOutputs?: Readonly<Record<string, string>>;
    /** Pointer op: resolve `config.accessor` from the `pointer` configuration +
     *  literal segment value sockets; segment inputs are NOT block data inputs. */
    readonly pointer?: boolean;
    /** Sequence-style: `outputSignalCount` = number of flow keys; the i-th flow
     *  (sorted) maps to signal `out_i`. */
    readonly dynamicSequence?: boolean;
    /** Variable op: the glTF configuration key holding the variable index/indices
     *  (`variable` for get, `variables` for set). */
    readonly variableConfigKey?: string;
    /** Event op: copy a numeric glTF `configuration` value into `config[key]`
     *  (e.g. `nodeIndex` for `event/onSelect`). */
    readonly nodeConfigKey?: string;
    /**
     * glTF `configuration` keys to copy as SCALAR values into block config.
     * Parser copies `node.configuration[gltfKey].value[0]` → `config[liteName]`.
     * Use for booleans, numbers, counts, and other single-element values.
     * ⚠️ SPEC-VOLATILE: quarantined here; re-sync against BJS PR #18455.
     */
    readonly configKeys?: Readonly<Record<string, string>>;
    /**
     * glTF `configuration` keys to copy as ARRAY values into block config.
     * Parser copies `node.configuration[gltfKey].value` (full array) →
     * `config[liteName]`. Use for `cases` arrays and other multi-element lists.
     * ⚠️ SPEC-VOLATILE: quarantined here; re-sync against BJS PR #18455.
     */
    readonly configArrayKeys?: Readonly<Record<string, string>>;
    /**
     * Switch-style dynamic output renaming: glTF flow key `"N"` → Lite signal
     * output `"out_N"` (except `"default"` which passes through unchanged).
     * Mirrors BJS FlowGraphSwitchBlock's `extraProcessor` renaming logic.
     */
    readonly switchOutputs?: boolean;
}

const FPS = (arr: number[]): number[] => [(arr[0] ?? 0) * ANIMATION_FPS];

/** Native (no-extension) KHR_interactivity op → Lite block mapping. */
const NATIVE_OPS: Readonly<Record<string, FgOpMapping>> = {
    "event/onStart": { block: FgBlockType.SceneStart, flowOutputs: { out: "done" } },
    "event/onTick": { block: FgBlockType.SceneTick, outputValues: { timeSinceLastTick: "deltaTime" }, flowOutputs: { out: "done" } },

    "flow/branch": { block: FgBlockType.Branch, valueInputs: { condition: "condition" }, flowOutputs: { true: "onTrue", false: "onFalse" } },
    "flow/sequence": { block: FgBlockType.Sequence, dynamicSequence: true },

    // ─── Phase 3h control-flow ops ────────────────────────────────────────────
    // flow/switch: glTF input `selection` → Lite `case`; flow keys are the raw
    // case integers ("0","1",...) — `switchOutputs` prefixes them to `out_N`.
    "flow/switch": { block: FgBlockType.Switch, valueInputs: { selection: "case" }, configArrayKeys: { cases: "cases" }, switchOutputs: true },
    // flow/for: `loopBody` → `executionFlow` (glTF name differs from BJS internal).
    "flow/for": { block: FgBlockType.ForLoop, configKeys: { initialIndex: "initialIndex" }, flowOutputs: { loopBody: "executionFlow" } },
    // flow/while: same loopBody rename.
    "flow/while": { block: FgBlockType.WhileLoop, flowOutputs: { loopBody: "executionFlow" } },
    // flow/doN: glTF `n` → `maxExecutions`; `currentCount` → `executionCount`.
    "flow/doN": { block: FgBlockType.DoN, valueInputs: { n: "maxExecutions" }, outputValues: { currentCount: "executionCount" } },
    // flow/multiGate: output count from flow count (dynamicSequence); booleans from configKeys.
    "flow/multiGate": { block: FgBlockType.MultiGate, dynamicSequence: true, configKeys: { isRandom: "isRandom", isLoop: "isLoop" } },
    // flow/waitAll: input count from glTF config key `inputFlows`.
    "flow/waitAll": { block: FgBlockType.WaitAll, configKeys: { inputFlows: "inputSignalCount" } },
    // flow/throttle, flow/setDelay: `err` glTF output → `error` Lite signal.
    "flow/throttle": { block: FgBlockType.Throttle, flowOutputs: { err: "error" } },
    "flow/setDelay": { block: FgBlockType.SetDelay, flowOutputs: { err: "error" } },
    "flow/cancelDelay": { block: FgBlockType.CancelDelay },

    "math/add": { block: FgBlockType.Add, valueInputs: { a: "a", b: "b" } },
    "math/sub": { block: FgBlockType.Subtract, valueInputs: { a: "a", b: "b" } },
    "math/mul": { block: FgBlockType.Multiply, valueInputs: { a: "a", b: "b" } },
    "math/div": { block: FgBlockType.Divide, valueInputs: { a: "a", b: "b" } },
    "math/rem": { block: FgBlockType.Modulo, valueInputs: { a: "a", b: "b" } },
    "math/abs": { block: FgBlockType.Abs, valueInputs: { a: "a" } },
    "math/floor": { block: FgBlockType.Floor, valueInputs: { a: "a" } },
    "math/lt": { block: FgBlockType.LessThan, valueInputs: { a: "a", b: "b" } },
    "math/clamp": { block: FgBlockType.Clamp, valueInputs: { a: "a", b: "b", c: "c" } },
    "math/combine2": { block: FgBlockType.CombineVector2, valueInputs: { a: "a", b: "b" } },
    "math/extract2": { block: FgBlockType.ExtractVector2, valueInputs: { a: "a" }, outputValues: { "0": "x", "1": "y" } },
    // ─── Phase 3 math (pass-through a/b/c sockets) ───────────────────────────
    "math/neg": { block: FgBlockType.Negation },
    "math/sign": { block: FgBlockType.Sign },
    "math/ceil": { block: FgBlockType.Ceil },
    "math/round": { block: FgBlockType.Round },
    "math/trunc": { block: FgBlockType.Trunc },
    "math/fract": { block: FgBlockType.Fraction },
    "math/saturate": { block: FgBlockType.Saturate },
    "math/sqrt": { block: FgBlockType.SquareRoot },
    "math/cbrt": { block: FgBlockType.CubeRoot },
    "math/exp": { block: FgBlockType.Exponential },
    "math/log": { block: FgBlockType.Log },
    "math/log2": { block: FgBlockType.Log2 },
    "math/log10": { block: FgBlockType.Log10 },
    "math/rad": { block: FgBlockType.DegToRad },
    "math/deg": { block: FgBlockType.RadToDeg },
    "math/sin": { block: FgBlockType.Sin },
    "math/cos": { block: FgBlockType.Cos },
    "math/tan": { block: FgBlockType.Tan },
    "math/asin": { block: FgBlockType.Asin },
    "math/acos": { block: FgBlockType.Acos },
    "math/atan": { block: FgBlockType.Atan },
    "math/sinh": { block: FgBlockType.Sinh },
    "math/cosh": { block: FgBlockType.Cosh },
    "math/tanh": { block: FgBlockType.Tanh },
    "math/asinh": { block: FgBlockType.Asinh },
    "math/acosh": { block: FgBlockType.Acosh },
    "math/atanh": { block: FgBlockType.Atanh },
    "math/min": { block: FgBlockType.Min },
    "math/max": { block: FgBlockType.Max },
    "math/pow": { block: FgBlockType.Power },
    "math/atan2": { block: FgBlockType.Atan2 },
    "math/eq": { block: FgBlockType.Equality },
    "math/le": { block: FgBlockType.LessThanOrEqual },
    "math/gt": { block: FgBlockType.GreaterThan },
    "math/ge": { block: FgBlockType.GreaterThanOrEqual },
    "math/isNaN": { block: FgBlockType.IsNaN },
    "math/isInf": { block: FgBlockType.IsInfinity },
    "math/and": { block: FgBlockType.BitwiseAnd },
    "math/or": { block: FgBlockType.BitwiseOr },
    "math/xor": { block: FgBlockType.BitwiseXor },
    "math/not": { block: FgBlockType.BitwiseNot },
    "math/lsl": { block: FgBlockType.BitwiseLeftShift },
    "math/asr": { block: FgBlockType.BitwiseRightShift },
    "math/clz": { block: FgBlockType.LeadingZeros },
    "math/ctz": { block: FgBlockType.TrailingZeros },
    "math/popcnt": { block: FgBlockType.OneBitsCounter },
    "math/length": { block: FgBlockType.Length },
    "math/normalize": { block: FgBlockType.Normalize },
    "math/dot": { block: FgBlockType.Dot },
    "math/cross": { block: FgBlockType.Cross },
    "math/rotate3D": { block: FgBlockType.Rotate3D },
    "math/mix": { block: FgBlockType.MathInterpolation },
    "math/combine3": { block: FgBlockType.CombineVector3 },
    "math/combine4": { block: FgBlockType.CombineVector4 },
    "math/E": { block: FgBlockType.E },
    "math/Pi": { block: FgBlockType.PI },
    "math/Inf": { block: FgBlockType.Inf },
    "math/NaN": { block: FgBlockType.NaN },
    "math/random": { block: FgBlockType.Random },
    "type/boolToFloat": { block: FgBlockType.BooleanToFloat },
    "type/boolToInt": { block: FgBlockType.BooleanToInt },
    "type/floatToBool": { block: FgBlockType.FloatToBoolean },
    "type/intToBool": { block: FgBlockType.IntToBoolean },
    "type/intToFloat": { block: FgBlockType.IntToFloat },
    "type/floatToInt": { block: FgBlockType.FloatToInt },
    // ─── Phase 3 math (custom socket / output mapping) ───────────────────────
    "math/extract3": { block: FgBlockType.ExtractVector3, outputValues: { "0": "x", "1": "y", "2": "z" } },
    "math/extract4": { block: FgBlockType.ExtractVector4, outputValues: { "0": "x", "1": "y", "2": "z", "3": "w" } },
    "math/rotate2D": { block: FgBlockType.Rotate2D, valueInputs: { a: "a", angle: "b" } },
    "math/select": { block: FgBlockType.Conditional, valueInputs: { condition: "condition", a: "onTrue", b: "onFalse" } },
    // math/switch: data switch; cases array from glTF configuration.
    "math/switch": { block: FgBlockType.DataSwitch, configArrayKeys: { cases: "cases" } },

    // ─── Phase 3f (matrix + quaternion) ──────────────────────────────────────
    "math/transform": { block: FgBlockType.TransformVector },
    "math/transpose": { block: FgBlockType.Transpose },
    "math/determinant": { block: FgBlockType.Determinant },
    "math/inverse": { block: FgBlockType.InvertMatrix },
    "math/matMul": { block: FgBlockType.MatrixMultiplication },
    "math/matCompose": {
        block: FgBlockType.MatrixCompose,
        valueInputs: { translation: "position", rotation: "rotationQuaternion", scale: "scaling" },
    },
    "math/matDecompose": {
        block: FgBlockType.MatrixDecompose,
        valueInputs: { a: "input" },
        outputValues: { translation: "position", rotation: "rotationQuaternion", scale: "scaling" },
    },
    "math/combine2x2": {
        block: FgBlockType.CombineMatrix2D,
        valueInputs: { a: "input_0", b: "input_1", c: "input_2", d: "input_3" },
    },
    "math/combine3x3": {
        block: FgBlockType.CombineMatrix3D,
        valueInputs: { a: "input_0", b: "input_1", c: "input_2", d: "input_3", e: "input_4", f: "input_5", g: "input_6", h: "input_7", i: "input_8" },
    },
    "math/combine4x4": {
        block: FgBlockType.CombineMatrix,
        valueInputs: {
            a: "input_0",
            b: "input_1",
            c: "input_2",
            d: "input_3",
            e: "input_4",
            f: "input_5",
            g: "input_6",
            h: "input_7",
            i: "input_8",
            j: "input_9",
            k: "input_10",
            l: "input_11",
            m: "input_12",
            n: "input_13",
            o: "input_14",
            p: "input_15",
        },
    },
    "math/extract2x2": {
        block: FgBlockType.ExtractMatrix2D,
        valueInputs: { a: "input" },
        outputValues: { "0": "output_0", "1": "output_1", "2": "output_2", "3": "output_3" },
    },
    "math/extract3x3": {
        block: FgBlockType.ExtractMatrix3D,
        valueInputs: { a: "input" },
        outputValues: { "0": "output_0", "1": "output_1", "2": "output_2", "3": "output_3", "4": "output_4", "5": "output_5", "6": "output_6", "7": "output_7", "8": "output_8" },
    },
    "math/extract4x4": {
        block: FgBlockType.ExtractMatrix,
        valueInputs: { a: "input" },
        outputValues: {
            "0": "output_0",
            "1": "output_1",
            "2": "output_2",
            "3": "output_3",
            "4": "output_4",
            "5": "output_5",
            "6": "output_6",
            "7": "output_7",
            "8": "output_8",
            "9": "output_9",
            "10": "output_10",
            "11": "output_11",
            "12": "output_12",
            "13": "output_13",
            "14": "output_14",
            "15": "output_15",
        },
    },
    "math/quatConjugate": { block: FgBlockType.Conjugate },
    "math/quatAngleBetween": { block: FgBlockType.AngleBetween },
    "math/quatFromAxisAngle": { block: FgBlockType.QuaternionFromAxisAngle, valueInputs: { axis: "a", angle: "b" } },
    "math/quatToAxisAngle": { block: FgBlockType.AxisAngleFromQuaternion },
    "math/quatFromDirections": { block: FgBlockType.QuaternionFromDirections },
    // math/quatMul: BJS reuses the generic Multiply with config.type=Quaternion;
    // Lite has a dedicated Hamilton-product block (generic Multiply is component-
    // wise). glTF inputs `a`/`b` map to identically named sockets.
    "math/quatMul": { block: FgBlockType.QuaternionMultiplication },

    "variable/get": { block: FgBlockType.GetVariable, variableConfigKey: "variable" },
    "variable/set": { block: FgBlockType.SetVariable, variableConfigKey: "variables", valueInputs: { value: "value" } },

    "pointer/get": { block: FgBlockType.GetProperty, pointer: true },
    "pointer/set": { block: FgBlockType.SetProperty, pointer: true, valueInputs: { value: "value" }, flowOutputs: { err: "error" } },

    "animation/start": {
        block: FgBlockType.PlayAnimation,
        valueInputs: { animation: "animation", speed: "speed", startTime: "from", endTime: "to" },
        valueTransform: { startTime: FPS, endTime: FPS },
        flowOutputs: { err: "error" },
    },
    "animation/stop": { block: FgBlockType.StopAnimation, valueInputs: { animation: "animation" }, flowOutputs: { err: "error" } },
    // animation/stopAt: defers the stop until playback reaches `stopAtFrame`.
    // glTF `stopTime` (seconds) → `stopAtFrame` via the FPS transform.
    "animation/stopAt": {
        block: FgBlockType.StopAnimation,
        valueInputs: { animation: "animation", stopTime: "stopAtFrame" },
        valueTransform: { stopTime: FPS },
        flowOutputs: { err: "error" },
    },

    // debug/log: core op (vs BABYLON-extension flow/log). The `message` config is
    // a template with `{name}` placeholders that the ConsoleLog block expands.
    "debug/log": { block: FgBlockType.ConsoleLog, configKeys: { message: "messageTemplate" } },

    // ─── Phase 3i event ops ────────────────────────────────────────────────────
    // event/send: `configuration["event"]` holds the integer event-table index,
    // copied into `config.eventId` as a scalar.  Value parameters from the glTF
    // events table are a deferred Phase 3i+ item (parser doesn't yet read
    // `json.events`, so sockets beyond the eventId are not wired from glTF).
    "event/send": { block: FgBlockType.SendCustomEvent, configKeys: { event: "eventId" } },
    // event/receive: same index → eventId mapping; glTF flow key `out` maps to
    // the Lite `done` signal (BJS convention for event blocks).
    "event/receive": { block: FgBlockType.ReceiveCustomEvent, configKeys: { event: "eventId" }, flowOutputs: { out: "done" } },

    // ─── Phase 3i interpolation ops ───────────────────────────────────────────
    // variable/interpolate: glTF `value` input → Lite `endValue`; `duration`
    // passes through.  `useSlerp` config → `config.useSlerp` (boolean).
    // Easing control points `p1`/`p2` (BezierCurveEasing) are deferred.
    // Pointer/variable target wiring (SetProperty after done) is also deferred.
    "variable/interpolate": {
        block: FgBlockType.ValueInterpolation,
        valueInputs: { value: "endValue", duration: "duration" },
        configKeys: { useSlerp: "useSlerp" },
        flowOutputs: { err: "error" },
    },
    // pointer/interpolate: same inputs; adds accessor resolution from the pointer
    // configuration so the block can eventually write its `value` to a property.
    "pointer/interpolate": {
        block: FgBlockType.ValueInterpolation,
        pointer: true,
        valueInputs: { value: "endValue", duration: "duration" },
        configKeys: { useSlerp: "useSlerp" },
        flowOutputs: { err: "error" },
    },
};

/** Babylon-extension ops (`declaration.extension === "BABYLON"`). */
const BABYLON_OPS: Readonly<Record<string, FgOpMapping>> = {
    "flow/log": { block: FgBlockType.ConsoleLog, valueInputs: { message: "message" } },
};

/** KHR_node_selectability ops (`declaration.extension === "KHR_node_selectability"`). */
const KHR_NODE_SELECTABILITY_OPS: Readonly<Record<string, FgOpMapping>> = {
    "event/onSelect": { block: FgBlockType.OnSelect, nodeConfigKey: "nodeIndex" },
};

/** Extension-namespaced op tables, keyed by `declaration.extension`. */
const EXTENSION_OPS: Readonly<Record<string, Readonly<Record<string, FgOpMapping>>>> = {
    BABYLON: BABYLON_OPS,
    KHR_node_selectability: KHR_NODE_SELECTABILITY_OPS,
};

/** Look up the Lite mapping for a glTF op, honoring the declaration `extension`.
 *  Returns `null` for an unknown op so the parser can fail loudly. */
export function getOpMapping(op: string, extension?: string): FgOpMapping | null {
    if (extension) {
        return EXTENSION_OPS[extension]?.[op] ?? null;
    }
    return NATIVE_OPS[op] ?? null;
}

/** Every distinct Lite block type referenced by some op mapping (native or
 *  extension). Used by a coverage guard to prove every mapped op resolves to a
 *  registered block def. */
export function allMappedBlockTypes(): FgBlockType[] {
    const types = new Set<FgBlockType>();
    for (const m of Object.values(NATIVE_OPS)) {
        types.add(m.block);
    }
    for (const table of Object.values(EXTENSION_OPS)) {
        for (const m of Object.values(table)) {
            types.add(m.block);
        }
    }
    return [...types];
}
