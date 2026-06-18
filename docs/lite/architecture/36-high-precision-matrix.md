# Module: High-Precision Matrix (HPM)
> Package paths: `packages/babylon-lite/src/math/_matrix-allocator.ts`, `packages/babylon-lite/src/math/_mat4-storage-f64.ts`, `packages/babylon-lite/src/math/pack-mat4-into-f32.ts`

## Purpose

High-Precision Matrix (HPM) is the optional Float64 backing for `Mat4`. When the engine is created with `useHighPrecisionMatrix: true`, every matrix allocation on the page returns `Float64Array(16)` instead of `Float32Array(16)`. CPU-side matrix composition (parent-chain world matrices, lookAt, inverse) is then done in F64, which preserves sub-unit precision at large coordinates (~1e5+ from origin) where F32 quantization becomes visible. The single F64→F32 down-cast happens at one explicit boundary — `packMat4IntoF32` — when the matrix is written into a GPU uniform buffer.

HPM is the substrate that Large World Rendering (`35-large-world-rendering.md`) builds on: floating-origin subtracts the eye position from the world translation in F64 *before* the F32 store, recovering the small remainder at full precision.

## Public API Surface

### Engine option (`engine/engine.ts`)

```typescript
export interface EngineOptions {
    /** When true, world matrices are computed using Float64 intermediate
     *  precision and downcast to Float32 at GPU upload time. Defaults to false. */
    useHighPrecisionMatrix?: boolean;
    // ...
}
```

### Process-global allocator (`math/_matrix-allocator.ts`)

```typescript
/** Allocate a fresh zero-initialized 16-element `Mat4`. Returns an F32 array
 *  by default, or F64 if any engine on the page was created with
 *  `useHighPrecisionMatrix: true`. */
export function allocateMat4(): Mat4;

/** @internal Install the HPM (F64) allocator. Called once by `createEngine`
 *  when `useHighPrecisionMatrix: true`. Subsequent calls overwrite. */
export function _setHpmAllocator(allocate: () => Mat4): void;

/** @internal Reset to F32 default — test-only. */
export function _resetMatrixAllocatorForTests(): void;
```

### F64 backing module (`math/_mat4-storage-f64.ts`)

```typescript
/** @internal F64-backed Mat4 allocator. Dynamic-imported by createEngine
 *  inside `if (options.useHighPrecisionMatrix)`. Tree-shaken out of HPM-off
 *  bundles. This module is the ONLY place in the package that names
 *  `new Float64Array(16)`. */
export function allocateF64Mat4(): Mat4;

/** @internal Build-time tag string asserted absent from HPM-off bundles by
 *  `tests/bundle-content-no-f64.test.ts`. */
export const MAT4_STORAGE_F64_BUILD_TAG = "@@MAT4_STORAGE_F64@@";
```

### GPU packing boundary (`math/pack-mat4-into-f32.ts`)

```typescript
/** @internal Pack one Mat4 into a Float32Array upload view at the given float
 *  offset. Source storage may be F32 or F64; this is the only place in the
 *  package where F64→F32 downcast happens for GPU upload. Does not allocate.
 *
 *  When `srcOffsetFloats` is provided, the helper reads 16 floats starting at
 *  `src[srcOffsetFloats]` instead of `src[0]` — used by thin-instance and
 *  similar packed-slab uploaders.
 *
 *  When `offsetXYZ` is provided, the floating-origin offset is subtracted from
 *  the translation column `[12..14]` during pack — see LWR (doc 27).
 *  Subtraction happens in JavaScript number precision (F64) BEFORE the
 *  implicit F32 store, so `large - large = small` is computed at full F64 and
 *  a single F32 store rounds the remainder with ample headroom. */
export function packMat4IntoF32(
    view: Float32Array,
    mat: Mat4 | Float32Array | Float64Array,
    offsetFloats?: number,
    srcOffsetFloats?: number,
    offsetXYZ?: readonly [number, number, number]
): void;
```

## Internal architecture

### Single allocator singleton (process-global)

The allocator is **process-global** — a single `let _allocate: () => Mat4` module-level binding in `_matrix-allocator.ts`. The default returns `Float32Array(16)`; calling `_setHpmAllocator(allocateF64Mat4)` from `createEngine` swaps it to the F64 backing for the rest of the process lifetime.

This violates the original M0 design (which had `engine._matrixPolicy` as a per-engine field) for the sake of bundle size: passing a per-engine allocator through every entity factory, scene cache, and loader scratch added ~300-500 bytes per bundle. The singleton's lazy-init form (`let _allocate = () => …` is a function-expression assignment, not initialization) keeps the module tree-shakable per GUIDANCE pillar 4 line 35.

**Constraint:** pages that mix HPM and non-HPM engines on the same page are unsupported. The second engine silently inherits the first's precision; meshes and cameras created against it will use the wrong storage. There is no runtime check — violating the rule produces silently incorrect results. This is the trade we accepted for the bundle-size savings of the singleton over the original per-engine `_matrixPolicy` field.

### Dynamic-import gate for the F64 backing

`createEngine` dynamic-imports `_mat4-storage-f64.ts` only inside `if (useHpm)`. With `useHighPrecisionMatrix` left at its default `false`, Vite's bundler proves the import target unreachable and tree-shakes the entire module from HPM-off bundles. `tests/bundle-content-no-f64.test.ts` asserts this two ways: (1) the build-tag string `@@MAT4_STORAGE_F64@@` does not appear anywhere in any HPM-off bundle, and (2) `lab/public/bundle/manifest.json` never lists `_mat4-storage-f64` as a runtime chunk for an HPM-off scene.

### Mat4 type vs. Mat4Storage

The public `Mat4` interface is opaque, read-only, and branded so users cannot fabricate or accidentally write to matrices vended by the engine. Internal kernels (`mat4Multiply`, `mat4Invert`, `packMat4IntoF32`, allocators) operate on the raw `Mat4Storage = Float32Array | Float64Array` union, which is writable and brand-free. The two types describe the same memory; you cross between them via `as unknown as Mat4Storage` / `as unknown as Mat4` at the trust boundary. See `21-core-math.md` for full type details.

### Per-load glTF scratch

The glTF loader uses three reusable scratch matrices (`tmpLocal`, `tmpAnim`, `tmpInstance`) in `loader-gltf/_loader-scratch.ts`, exposed via module-level lazy getters:

```typescript
let _tmpLocal: Mat4 | null = null;
export function getLoaderTmpLocal(): Mat4 {
    return (_tmpLocal ??= allocateMat4());
}
```

Lazy-init via `allocateMat4()` means the scratch picks up whatever precision the process-global allocator was installed with. Safe to share across concurrent `loadGltf` calls because all parser paths that touch scratch are synchronous between scratch reads/writes (only `await`s are around fetch and image decode, neither touches matrix scratch). JS single-threadedness guarantees no other parse can interleave through a scratch use-site mid-computation.

## GPU upload boundary inventory

Every mat4 → GPU buffer write goes through `packMat4IntoF32`. The exhaustive list:

- `frame-graph/render-task.ts` — view, projection, view-projection uploads for the scene UBO
- `material/standard/standard-renderable.ts` — mesh-world matrix in the standard renderable's mesh UBO (initial + per-frame update)
- `material/pbr/pbr-renderable.ts` — same for PBR renderables
- `material/node/node-renderable.ts` — same for node-material renderables
- `mesh/thin-instance-gpu.ts` — thin-instance world matrix slabs (subarray pack via `srcOffsetFloats`)
- `shadow/esm-directional-shadow-generator.ts`, `shadow/pcf-shadow-task-hooks.ts`, `shadow/shadow-base.ts` — shadow `_lightMatrix` packs

The 6 mesh-world callsites pass `_foOffset` as the 5th argument (the scene's `_floatingOriginOffset` reference). The non-mesh callsites omit the offset and get precision-only packing (a bit-identical copy when storage is F32).

## Validation

- Unit: `tests/unit/engine-matrix-policy.test.ts` covers `allocateMat4()` returning F32 by default, F64 after `_setHpmAllocator`, fresh instances per call, and `_resetMatrixAllocatorForTests` reverting.
- Unit: `tests/unit/pack-mat4-into-f32.test.ts` covers F32→F32 bit-identity, F64→F32 down-cast, source/dst offsets, and the LWR offset-subtraction path.
- Bundle: `tests/bundle-content-no-f64.test.ts` enforces F64 tree-shaking from HPM-off bundles (string-tag absence + manifest disjointness).
- Bundle: scene-config ceilings — bundle-size tests confirm HPM-off scenes stay within their fixed ceilings; the F64 chunk only ships when reachable.

## Files / size

| File | Purpose |
|------|---------|
| `math/_matrix-allocator.ts` (~40 lines) | Process-global lazy-init allocator + install hook |
| `math/_mat4-storage-f64.ts` (~25 lines) | F64 allocator function + build tag |
| `math/pack-mat4-into-f32.ts` (~60 lines) | Single GPU upload boundary with optional FO offset |
| `math/types.ts` (Mat4, Mat4Storage) | Opaque branded `Mat4` + raw `Mat4Storage` union |
