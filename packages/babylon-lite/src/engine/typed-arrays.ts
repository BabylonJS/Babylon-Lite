/**
 * Short aliases for global typed-array / DataView constructors.
 *
 * These globals cannot be renamed by the minifier, so each `new Float32Array`
 * ships the full constructor name. Importing these aliases (mangled to a single
 * character per chunk) shrinks every `new`/`instanceof` use to a tiny token with
 * identical runtime semantics. Aliases are value-only and used solely in value
 * positions (construction / `instanceof`); type annotations keep the real names.
 */
export const F32 = Float32Array;
export const F64 = Float64Array;
export const U32 = Uint32Array;
export const I32 = Int32Array;
export const U16 = Uint16Array;
export const I16 = Int16Array;
export const U8 = Uint8Array;
export const I8 = Int8Array;
export const U8C = Uint8ClampedArray;
export const DV = DataView;
