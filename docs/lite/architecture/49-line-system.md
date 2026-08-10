# Module: Line System

> Package paths: `packages/babylon-lite/src/mesh/create-line-system.ts`, `packages/babylon-lite/src/mesh/create-dashed-lines.ts`, `packages/babylon-lite/src/material/line/`

## Purpose

Provide a public, tree-shakable equivalent of Babylon.js `CreateLines`, `CreateLineSystem`, and `CreateDashedLines`.
A line system concatenates several independent polylines into one indexed `Mesh`, renders the
indices as a WebGPU `line-list`, and optionally carries one RGBA color per point.

The result is an ordinary Babylon Lite `Mesh`, not an OOP `LinesMesh`. Geometry, material, scene
ownership, and behavior remain separate:

- the mesh stores plain geometry and transform state;
- `LineMaterial` is a plain `ShaderMaterial` state object;
- standalone functions create and update both;
- the scene owns the mesh only after `addToScene(scene, mesh)`.

## Public API Surface

```ts
export interface LineSystemData {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    readonly colors?: Float32Array;
    readonly linePointCounts: Uint32Array;
}

export interface LineSystemDataOptions {
    readonly lines: readonly (readonly Vec3[])[];
    readonly colors?: readonly (readonly Color4[])[];
}

export interface LineMaterialOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexColor?: boolean;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
}

export interface LineMaterial extends ShaderMaterial {
    readonly useVertexColor: boolean;
    readonly useVertexAlpha: boolean;
    readonly useThinInstances: boolean;
    readonly useThinInstanceColors: boolean;
    readonly color: Color4;
}

export interface LineSystemOptions extends LineSystemDataOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LinesOptions {
    readonly name?: string;
    readonly points: readonly Vec3[];
    readonly colors?: readonly Color4[];
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LineSystemUpdateOptions extends LineSystemDataOptions {}

export interface DashedLinesOptions {
    readonly name?: string;
    readonly points: readonly Vec3[];
    readonly dashSize?: number;
    readonly gapSize?: number;
    readonly dashNb?: number;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly material?: LineMaterial;
}

export interface DashedLinesUpdateOptions {
    readonly points: readonly Vec3[];
}

export function createLineSystemData(options: LineSystemDataOptions): LineSystemData;
export function createLineMaterial(options?: LineMaterialOptions): LineMaterial;
export function setLineMaterialColor(material: LineMaterial, color: Color4): void;
export function createLineSystem(engine: EngineContext, options: LineSystemOptions): Mesh;
export function createLines(engine: EngineContext, options: LinesOptions): Mesh;
export function updateLineSystem(engine: EngineContext, mesh: Mesh, options: LineSystemUpdateOptions): void;
export function createDashedLines(engine: EngineContext, options: DashedLinesOptions): Mesh;
export function updateDashedLines(engine: EngineContext, mesh: Mesh, options: DashedLinesUpdateOptions): void;
```

Defaults:

- `name`: `"lineSystem"` (`"lines"` for `createLines`)
- dashed-line `name`: `"dashedLines"`
- `dashSize`: `3`
- `gapSize`: `1`
- `dashNb`: `200`
- `color`: opaque white
- `useVertexColor`: inferred from `colors` by `createLineSystem`
- `useVertexAlpha`: `true`, matching Babylon.js `LinesMesh`
- `useThinInstances`: `false`
- `useThinInstanceColors`: `false`
- depth comparison: the ordinary reverse-depth ShaderMaterial default
- depth writes: ShaderMaterial default (`false` for alpha-blended lines, `true` otherwise)

When a caller supplies `material`, its `useVertexColor` setting must match whether the geometry has
a color buffer. `useThinInstances` and `useThinInstanceColors` are material compile-time choices:
the material must be created for the mesh's intended draw path before `registerScene`.

## Internal Architecture

### Geometry layout

All points are concatenated in line order.

For line `l` with `N` points:

- append all `N` XYZ positions;
- append all `N` RGBA colors when `colors` is present;
- append index pairs `(base + i - 1, base + i)` for `i = 1..N-1`;
- never connect the final point of one line to the first point of the next.

Counts:

- vertices: `sum(line.length)`
- indices: `sum(max(0, line.length - 1) * 2)`
- normals: one zero XYZ tuple per vertex, because the shared mesh uploader requires a normal
  buffer but the line shader never binds or reads it.

`linePointCounts` stores one count per polyline. The mesh retains the same array internally as
`Mesh._linePointCounts`; updates compare every entry so a caller cannot silently change segment
connectivity while keeping the same total vertex count.

`Mesh._topology = 2` records the same internal topology index used by the glTF primitive feature
(`2 = line-list`). This makes procedural and loaded line primitives share the same mesh state
representation even though their materials use different render paths.

### Dashed-line generation and updates

`createDashedLines` measures the complete input polyline, divides that length into `dashNb` steps,
and emits one independent two-point line for every complete step on each source segment. The visible
portion of each step is `dashSize / (dashSize + gapSize)`. Source-segment boundaries restart the
step phase, matching Babylon.js.

The mesh retains its creation-time dash/gap ratio in `Mesh._dashedLineOptions`; its actual emitted
dash count is already retained by `Mesh._linePointCounts`. `updateDashedLines` recomputes spacing
from the new total length and the existing dash count, caps writes at that fixed capacity, and fills
any unused tail with degenerate segments at the final point. The mesh identity, vertex/index counts,
and GPU buffers therefore remain stable.

### Validation

Creation throws before GPU allocation when:

- the complete system contains no points;
- any position component is non-finite;
- `colors.length !== lines.length`;
- a color row length differs from its matching line;
- any color component is non-finite.

Update throws before any GPU write when:

- line count or any per-line point count changed;
- position count changed;
- the mesh was not created by `createLineSystem`;
- colors are supplied for a mesh without a color buffer;
- color dimensions are invalid.

Dashed-line creation additionally requires at least two points and at least one generated dash.
Dashed-line updates require a mesh created by `createDashedLines`; degenerate replacement points are
valid and collapse every retained dash onto the final point.

Omitting `colors` during an update preserves an existing color buffer. A mesh created without
colors cannot gain them without creating/resizing a new line system.

### Material state

`LineMaterial` is produced by `createShaderMaterial` and keeps its ordinary render group, UBO,
thin-instance, stencil, sorting, disposal, and device-loss behavior.

The ShaderMaterial owns an internal `_topology = "line-list"` field. The shader pipeline includes
that topology in both local and cross-material pipeline cache keys and emits:

```ts
primitive: {
    topology: material._topology ?? "triangle-list",
    cullMode: "none",
    frontFace: "ccw",
}
```

No line-specific registry or module-level allocation is introduced.

`setLineMaterialColor` copies RGBA values into `material.color` and updates the `lineColor`
ShaderMaterial uniform. The uniform is present only when neither vertex colors nor thin-instance
colors replace it.

### Thin instances

The ordinary line material uses `shaderSystem.world`.

A material created with `useThinInstances: true` reads the matrix attributes dynamically injected by
the existing ShaderMaterial thin-instance path:

```wgsl
let instanceWorld = mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
let finalWorld = shaderSystem.world * instanceWorld;
```

`useThinInstanceColors: true` additionally reads `input.instanceColor`. It requires
`useThinInstances: true` and a thin-instance color buffer.

Color precedence matches Babylon.js's color shader:

- vertex colors only: output vertex color;
- instance colors only: output instance color;
- both: multiply vertex and instance RGBA;
- neither: output the uniform line color.

`useVertexAlpha` controls alpha blending, not whether the shader forwards alpha. When false, the
same RGBA value is written without blend state, matching Babylon.js.

## Pipeline Configuration

Vertex attributes:

| Feature              | Attributes                                |
| -------------------- | ----------------------------------------- |
| Uniform color        | `position: float32x3`                     |
| Vertex colors        | `position: float32x3`, `color: float32x4` |
| Thin instances       | plus four `float32x4` matrix rows         |
| Thin-instance colors | plus one `float32x4` color                |

Primitive state:

```ts
{
    topology: "line-list",
    cullMode: "none",
    frontFace: "ccw",
}
```

Blend state when `useVertexAlpha` is true:

```ts
{
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}
```

The existing ShaderMaterial depth, stencil, MSAA, render ordering, and render-target-signature rules
remain authoritative.

## Shader Logic

Uniform-color vertex shader:

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.viewProjection
        * shaderSystem.world
        * vec4<f32>(input.position, 1.0);
    return out;
}
```

Vertex/instance color variants add a `vColor: vec4<f32>` varying and assign the color precedence
defined above. The fragment stage returns `vColor` or the `lineColor` uniform unchanged. Lines are
unlit and do not sample textures.

## State Machine / Lifecycle

1. `createLineSystemData` validates and flattens CPU data.
2. `createLineSystem` uploads the data through `createMeshFromData`.
3. The mesh records `_topology`, `_linePointCounts`, retained CPU geometry, and a caller-provided or
   generated `LineMaterial`.
4. The caller may configure transforms, render order, stencil, and thin instances.
5. `addToScene` transfers ownership to a scene.
6. `registerScene` builds the ordinary ShaderMaterial renderable.
7. `updateLineSystem` validates topology, updates position/color buffers in place, refreshes retained
   CPU arrays, recomputes bounds, and refreshes device-loss recovery data.
8. `createDashedLines` builds ordinary two-point line-system rows and retains its creation-time
   dash/gap ratio; `updateDashedLines` regenerates exactly the existing row count.
9. Ordinary scene/mesh disposal releases all GPU resources.

## Babylon.js Equivalence Map

| Babylon.js                                            | Babylon Lite                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `CreateLineSystemVertexData`                          | `createLineSystemData`                                         |
| `MeshBuilder.CreateLineSystem` / `CreateLineSystem`   | `createLineSystem`                                             |
| `MeshBuilder.CreateLines` / `CreateLines`             | `createLines`                                                  |
| `MeshBuilder.CreateDashedLines` / `CreateDashedLines` | `createDashedLines`                                            |
| `LinesMesh` geometry                                  | ordinary `Mesh` with `_topology = 2`                           |
| `LinesMesh` default color shader                      | `LineMaterial`                                                 |
| `LinesMesh.color` + `.alpha`                          | `setLineMaterialColor`                                         |
| `options.instance` update                             | `updateLineSystem(engine, mesh, options)`                      |
| dashed `options.instance` update                      | `updateDashedLines(engine, mesh, options)`                     |
| `useVertexAlpha`                                      | `LineMaterial.useVertexAlpha`                                  |
| line thin instances                                   | existing `setThinInstances` with a thin-instance line material |

Initial limitations:

- one-pixel hardware lines only;
- no segment-distance picking / `intersectionThreshold`;
- updates cannot change line count, point counts, or color-buffer presence;
- triangle-specific shadow, geometry, and detailed-picking passes are not enabled for line systems.

## Dependencies

- `EngineContext`
- `Mesh`, `createMeshFromData`, `updateMeshPositions`, `updateMeshColors`
- `computeAabb`
- `Vec3`, `Color4`
- `ShaderMaterial`, `createShaderMaterial`, `setShaderUniform`
- existing ShaderMaterial thin-instance and stencil opt-ins

## Test Specification

Unit tests:

- flatten multiple lines without cross-line indices;
- preserve RGBA values in vertex order;
- keep empty/one-point polylines disconnected and reject an all-empty system, mismatched colors,
  and non-finite inputs;
- create a line-list material with the correct color/alpha/thin-instance variant;
- update positions/colors without replacing GPU buffers;
- reject changed line topology before GPU mutation;
- preserve colors when an update omits them;
- generate BJS-spaced dashed segments with default and explicit dash/gap/count values;
- update dashed positions without changing the retained dash topology;
- collapse unused dashed update slots onto the final point;
- verify ShaderMaterial pipeline cache separation between triangle and line topologies.

Visual parity scenes:

- static multi-polyline system with uniform and per-vertex colors, including translucent segments;
- updated line system rendered through thin instances with per-instance RGBA colors;
- Babylon.js reference pages use `MeshBuilder.CreateLineSystem`;
- Lite pages use `createLineSystem`, `updateLineSystem`, and existing thin-instance APIs.

Bundle checks:

- scenes without line imports retain no line generator or line shader code;
- each line scene stays below its explicit `maxRawKB` ceiling;
- regenerated per-scene runtime manifests are committed.

## File Manifest

- `packages/babylon-lite/src/mesh/create-line-system.ts`: geometry creation and updates.
- `packages/babylon-lite/src/mesh/create-dashed-lines.ts`: dashed geometry creation and fixed-topology updates.
- `packages/babylon-lite/src/material/line/line-material.ts`: line shader/material.
- `packages/babylon-lite/src/material/shader/shader-material.ts`: internal topology state.
- `packages/babylon-lite/src/material/shader/shader-pipeline.ts`: topology-aware pipeline creation.
- `packages/babylon-lite/src/material/shader/shader-pipeline-cache.ts`: topology cache key.
- `packages/babylon-lite/src/mesh/mesh.ts`: internal topology and line-count state.
- `packages/babylon-lite/src/index.ts`: public exports.
- `packages/babylon-lite-compat/src/meshes/meshes.ts`: `LinesMesh`, `CreateLines`, `CreateLineSystem`, and `CreateDashedLines` wrappers.
- `packages/babylon-lite-compat/COMPAT-STATUS.md`: compatibility status.
- `lab/lite/src/bjs/scene278.ts`, `lab/lite/src/lite/scene278.ts`: static parity scene.
- `lab/lite/src/bjs/scene279.ts`, `lab/lite/src/lite/scene279.ts`: update + thin-instance parity scene.
- `tests/lite/unit/create-line-system.test.ts`: unit coverage.
- `tests/lite/unit/create-dashed-lines.test.ts`: dashed creation and update coverage.
- `tests/lite/parity/scenes/scene278-line-system.spec.ts`: static visual parity.
- `tests/lite/parity/scenes/scene279-line-system-update-instances.spec.ts`: dynamic/instance visual parity.
