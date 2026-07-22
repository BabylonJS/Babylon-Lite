# Module: Mesh Geometry Access

> Package path: `packages/babylon-lite/src/mesh/get-mesh-geometry.ts`

## Purpose

Expose the CPU-side geometry already retained by a mesh without exposing internal fields or GPU
resources. Each call returns independent typed-array copies so callers can inspect or modify the
result without mutating picking, device-loss recovery, or future geometry updates on the mesh.

## Public API Surface

```ts
export function getMeshGeometry(mesh: Mesh): {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs?: Float32Array;
    uvs2?: Float32Array;
    tangents?: Float32Array;
    colors?: Float32Array;
} | null;
```

Positions, normals, and indices are the required geometry. The function returns `null` when any of
them is not retained on the CPU. UV, UV2, tangent, and color arrays are included only when the mesh
already retains them. The helper does not cause loaders or factories to retain additional data.

## Internal Architecture

The helper reads the mesh's internal CPU arrays once and copies each available array with typed-array
`slice()`. It never returns an internal array reference. Reading an interleaved glTF mesh can invoke
its existing lazy CPU accessor, which de-strides and caches a tight internal array; the helper still
returns a second, caller-owned copy.

The module has no runtime imports beyond the erased `Mesh` type import and has no module-level state
or side effects. Consumers that do not import `getMeshGeometry` retain no code from this module.

## Pipeline Configuration

None. The helper does not access or modify GPU buffers, bind groups, pipelines, draw state, bounds, or
materials.

## Shader Logic

None.

## State Machine / Lifecycle

1. A loader or factory creates a mesh and retains any CPU geometry needed by existing engine features.
2. `getMeshGeometry(mesh)` checks for required retained arrays.
3. If required data is unavailable, it returns `null`.
4. Otherwise it returns copies of required arrays and every retained optional array.
5. Callers may mutate or pass those copies to another API without changing the source mesh.

## Babylon.js Equivalence Map

Equivalent in purpose to reading positions, normals, UV sets, tangents, colors, and indices through
Babylon.js mesh vertex-data accessors, while presenting them as one tree-shakable Lite helper.

## Dependencies

- `Mesh` for retained CPU geometry.

## Test Specification

- Return exact copies of complete retained geometry.
- Verify no returned typed array aliases its internal source.
- Return `undefined` for unavailable optional attributes.
- Return `null` when any required array is unavailable.
- Exercise lazy getter-backed arrays used by interleaved glTF meshes.

## File Manifest

- `packages/babylon-lite/src/mesh/get-mesh-geometry.ts`: implementation.
- `packages/babylon-lite/src/index.ts`: public export.
- `tests/lite/unit/get-mesh-geometry.test.ts`: unit coverage.
