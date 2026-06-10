/**
 * Short aliases for the WebGPU global flag namespaces.
 *
 * `GPUTextureUsage`, `GPUBufferUsage`, `GPUShaderStage`, and `GPUColorWrite`
 * are global identifiers the minifier cannot rename, so every reference ships
 * the full ~14-char name. Importing these one-letter aliases (which the
 * minifier mangles to a single character per chunk) replaces the verbose
 * global with a tiny token at every flag use, with identical runtime values.
 */
export const TU = globalThis.GPUTextureUsage;
export const BU = globalThis.GPUBufferUsage;
export const SS = globalThis.GPUShaderStage;
export const CW = globalThis.GPUColorWrite;
