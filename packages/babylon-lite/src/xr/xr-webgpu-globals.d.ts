// Ambient runtime declaration for the **draft** WebXR/WebGPU binding global.
//
// No browser ships `XRGPUBinding` yet and no `@types/*` package declares it, so we
// declare the global here — typed by the self-contained `XrGpuBindingConstructor`
// interface — purely so Babylon Lite's own source compiles (`new XRGPUBinding(...)`
// in xr-session.ts, `typeof XRGPUBinding` in xr-support.ts).
//
// This file is a global script: it has no top-level `import`/`export`, so its
// `declare const` merges into the global scope. The inline `import(...)` is a
// type-only reference and does NOT turn the file into a module.
//
// It is deliberately NOT part of the public `.d.ts` rollup: the public API exposes
// the `XrGpuBinding` interface (via `XrSessionContext.binding`), never this global,
// so api-extractor never has to follow an ambient draft symbol.
declare const XRGPUBinding: import("./xr-webgpu-binding.js").XrGpuBindingConstructor;
