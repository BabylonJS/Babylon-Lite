// Lite block-type identifiers. `const enum` string tags → erased at build.
// String values mirror the BJS `FlowGraphBlockNames` / glTF op identifiers
// where practical so the declaration mapper can pass them through.
// Phase 1 ships NO block implementations; this enum is the stable name surface
// that block-registry.ts and the gltf mapper resolve against as blocks land.

export const enum FgBlockType {
    // ─── Events ───────────────────────────────────────────────
    SceneStart = "SceneReadyEvent",
    SceneTick = "SceneTickEvent",
    OnSelect = "OnSelect",
    SendCustomEvent = "SendCustomEvent",
    ReceiveCustomEvent = "ReceiveCustomEvent",

    // ─── Control flow ─────────────────────────────────────────
    Branch = "Branch",
    Sequence = "Sequence",
    Switch = "Switch",
    ForLoop = "ForLoop",
    WhileLoop = "WhileLoop",
    DoN = "DoN",
    MultiGate = "MultiGate",
    WaitAll = "WaitAll",
    Throttle = "Throttle",
    SetDelay = "SetDelay",
    CancelDelay = "CancelDelay",

    // ─── Data / math: arithmetic ──────────────────────────────
    Constant = "Constant",
    Add = "Add",
    Subtract = "Subtract",
    Multiply = "Multiply",
    Divide = "Divide",
    Modulo = "Modulo",
    Min = "Min",
    Max = "Max",
    Power = "Power",
    Negation = "Negation",

    // ─── Data / math: rounding + sign ─────────────────────────
    Abs = "Abs",
    Sign = "Sign",
    Floor = "Floor",
    Ceil = "Ceil",
    Round = "Round",
    Trunc = "Trunc",
    Fraction = "Fraction",
    Saturate = "Saturate",
    Clamp = "Clamp",

    // ─── Data / math: exp / log / roots ───────────────────────
    Exponential = "Exponential",
    Log = "Log",
    Log2 = "Log2",
    Log10 = "Log10",
    SquareRoot = "SquareRoot",
    CubeRoot = "CubeRoot",

    // ─── Data / math: trig + angles ───────────────────────────
    DegToRad = "DegToRad",
    RadToDeg = "RadToDeg",
    Sin = "Sin",
    Cos = "Cos",
    Tan = "Tan",
    Asin = "Asin",
    Acos = "Acos",
    Atan = "Atan",
    Atan2 = "Atan2",
    Sinh = "Sinh",
    Cosh = "Cosh",
    Tanh = "Tanh",
    Asinh = "Asinh",
    Acosh = "Acosh",
    Atanh = "Atanh",

    // ─── Data / math: comparison ──────────────────────────────
    Equality = "Equality",
    LessThan = "LessThan",
    LessThanOrEqual = "LessThanOrEqual",
    GreaterThan = "GreaterThan",
    GreaterThanOrEqual = "GreaterThanOrEqual",
    IsNaN = "IsNaN",
    IsInfinity = "IsInfinity",

    // ─── Data / math: constants ───────────────────────────────
    E = "E",
    PI = "PI",
    Inf = "Inf",
    NaN = "NaN",
    Random = "Random",

    // ─── Data / math: selection ───────────────────────────────
    Conditional = "Conditional",
    DataSwitch = "DataSwitch",

    // ─── Data / math: integer bitwise ─────────────────────────
    BitwiseAnd = "BitwiseAnd",
    BitwiseOr = "BitwiseOr",
    BitwiseXor = "BitwiseXor",
    BitwiseNot = "BitwiseNot",
    BitwiseLeftShift = "BitwiseLeftShift",
    BitwiseRightShift = "BitwiseRightShift",
    LeadingZeros = "LeadingZeros",
    TrailingZeros = "TrailingZeros",
    OneBitsCounter = "OneBitsCounter",

    // ─── Data / math: vector ops ──────────────────────────────
    Length = "Length",
    Normalize = "Normalize",
    Dot = "Dot",
    Cross = "Cross",
    MathInterpolation = "MathInterpolation",
    Rotate2D = "Rotate2D",
    Rotate3D = "Rotate3D",
    TransformVector = "TransformVector",

    // ─── Data / math: combine / extract ───────────────────────
    CombineVector2 = "CombineVector2",
    CombineVector3 = "CombineVector3",
    CombineVector4 = "CombineVector4",
    CombineMatrix2D = "CombineMatrix2D",
    CombineMatrix3D = "CombineMatrix3D",
    CombineMatrix = "CombineMatrix",
    ExtractVector2 = "ExtractVector2",
    ExtractVector3 = "ExtractVector3",
    ExtractVector4 = "ExtractVector4",
    ExtractMatrix2D = "ExtractMatrix2D",
    ExtractMatrix3D = "ExtractMatrix3D",
    ExtractMatrix = "ExtractMatrix",

    // ─── Data / math: matrix ──────────────────────────────────
    Transpose = "Transpose",
    Determinant = "Determinant",
    InvertMatrix = "InvertMatrix",
    MatrixMultiplication = "MatrixMultiplication",
    MatrixCompose = "MatrixCompose",
    MatrixDecompose = "MatrixDecompose",

    // ─── Data / math: quaternion ──────────────────────────────
    Conjugate = "Conjugate",
    AngleBetween = "AngleBetween",
    QuaternionFromAxisAngle = "QuaternionFromAxisAngle",
    AxisAngleFromQuaternion = "AxisAngleFromQuaternion",
    QuaternionFromDirections = "QuaternionFromDirections",
    QuaternionMultiplication = "QuaternionMultiplication",

    // ─── Data / type conversion ───────────────────────────────
    BooleanToFloat = "BooleanToFloat",
    BooleanToInt = "BooleanToInt",
    FloatToBoolean = "FloatToBoolean",
    IntToBoolean = "IntToBoolean",
    IntToFloat = "IntToFloat",
    FloatToInt = "FloatToInt",

    // ─── Pointer / variable / animation ───────────────────────
    GetProperty = "GetProperty",
    SetProperty = "SetProperty",
    JsonPointerParser = "JsonPointerParser",
    GetVariable = "GetVariable",
    SetVariable = "SetVariable",
    ValueInterpolation = "ValueInterpolation",
    PlayAnimation = "PlayAnimation",
    StopAnimation = "StopAnimation",

    // ─── Debug ────────────────────────────────────────────────
    ConsoleLog = "ConsoleLog",
}
