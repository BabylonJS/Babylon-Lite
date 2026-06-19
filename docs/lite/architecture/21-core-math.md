# Module: Core Math
> Package path: `packages/babylon-lite/src/math/`

## Purpose

The Core Math module provides all math types and pure functions used throughout Babylon Lite. Types are plain interfaces (not classes) for data-oriented GPU buffer packing. All functions are pure — they return new values without mutation. The module uses the **Babylon.js left-handed coordinate system** with **column-major matrices** matching WebGPU/WGSL `mat4x4<f32>` memory layout.

## Public API Surface

### Types (`types.ts`)

```typescript
/** 3-component vector (position, direction, color) */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 4-component vector (homogeneous coords, quaternion, tangent) */
export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** RGB color */
export interface Color3 {
  r: number;
  g: number;
  b: number;
}

/** RGBA color */
export interface Color4 {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 4x4 column-major matrix (16 elements). Opaque-by-convention: the
 *  underlying storage is `Float32Array` (default) or `Float64Array`
 *  (after an HPM engine is created — see `36-high-precision-matrix.md`).
 *  Layout matches WebGPU/WGSL mat4x4<f32> memory order. */
export interface Mat4 {
  readonly __brand: 'Mat4';
  readonly length: 16;
  readonly [index: number]: number;
}

/** @internal Writable backing for Mat4 used by kernels and the GPU packer.
 *  Raw typed-array union (no brand). Not re-exported from the public root API. */
export type Mat4Storage = Float32Array | Float64Array;

/** Quaternion rotation */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
```

### Vec3 Functions (`vec3.ts`)

```typescript
// --- Constructors ---
export function vec3(x: number, y: number, z: number): Vec3;

export const Vec3Up: Readonly<Vec3>; // { x: 0, y: 1, z: 0 }

// --- Arithmetic (all return new objects — no mutation) ---
export function addVec3(a: Vec3, b: Vec3): Vec3;
export function subVec3(a: Vec3, b: Vec3): Vec3;
export function scaleVec3(v: Vec3, s: number): Vec3;
export function dotVec3(a: Vec3, b: Vec3): number;
export function crossVec3(a: Vec3, b: Vec3): Vec3;
export function lengthVec3(v: Vec3): number;
export function normalizeVec3(v: Vec3): Vec3;
export function normalizeVec3Tuple(x: number, y: number, z: number, epsilon?: number): Vec3Tuple;
export function negateVec3(v: Vec3): Vec3;
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3;

/** Write Vec3 into a Float32Array at the given element offset (for uniform buffers). */
export function writeVec3(out: Float32Array, offset: number, v: Vec3): void;
```

### Mat4 Functions (`mat4.ts`)

```typescript
/** Create a new identity Mat4. */
export function mat4Identity(): Mat4;

/** Create a zero Mat4. */
export function mat4(): Mat4;

/** Multiply two Mat4: out = a * b (column-major). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4;

/** LookAt matrix (left-handed). */
export function mat4LookAtLH(eye: Vec3, target: Vec3, up: Vec3): Mat4;

/** Perspective projection (left-handed, zero-to-one depth). */
export function mat4PerspectiveLH(fov: number, aspect: number, near: number, far: number): Mat4;

/** Compute inverse of a Mat4. Returns null if singular. */
export function mat4Invert(m: Mat4): Mat4 | null;

/** Create a scaling matrix. */
export function mat4Scale(x: number, y: number, z: number): Mat4;

/** Create a translation matrix. */
export function mat4Translation(x: number, y: number, z: number): Mat4;

/** Create a rotation matrix from a quaternion. */
export function mat4FromQuat(qx: number, qy: number, qz: number, qw: number): Mat4;

/** Compose TRS (translation * rotation * scale) into a single Mat4. */
export function mat4Compose(
  tx: number, ty: number, tz: number,
  qx: number, qy: number, qz: number, qw: number,
  sx: number, sy: number, sz: number,
): Mat4;
```

### Color Functions (`color.ts`)

```typescript
export function linearToSrgbByte(v: number): number;
export function srgbByteToLinear(b: number): number;
export function packedSrgbToLinearRgba(packed: number, alpha?: number): readonly [number, number, number, number];
```

### Barrel Export (`index.ts`)

The internal math barrel (`math/index.ts`) re-exports every non-underscore math module surface, including internal helpers such as `Mat4Storage`, `mat4PerspectiveLHToRef`, `packMat4IntoF32`, and `shToPolynomial`.
The public root API exports the public-safe subset: vector/matrix constructors and operations, AABB helpers, color conversion helpers, and the public math types.
The object-based normalizer remains `normalizeVec3` in the math barrel. The public root keeps its existing tuple-based `normalizeVec3(x, y, z)` export and also exposes the object-based form as `normalizeVec3Object(v)`.

## Internal Architecture

### Mat4 Memory Layout (Column-Major)

```
Index:  [0]  [4]  [8]  [12]
        [1]  [5]  [9]  [13]
        [2]  [6]  [10] [14]
        [3]  [7]  [11] [15]

Column:  0    1    2    3

Logical matrix:
  | m[0]  m[4]  m[8]   m[12] |
  | m[1]  m[5]  m[9]   m[13] |
  | m[2]  m[6]  m[10]  m[14] |
  | m[3]  m[7]  m[11]  m[15] |
```

This matches WGSL `mat4x4<f32>` which stores columns contiguously. Mat4 values are written to GPU uniform buffers via the single packing helper `packMat4IntoF32` (see `36-high-precision-matrix.md`) — never directly via `Float32Array.set(mat)`, because the backing may be `Float64Array` when HPM is enabled and must be down-cast at the upload boundary.

### Branded Opaque Type

`Mat4` is an opaque interface, not a typed array:
```typescript
export interface Mat4 {
  readonly __brand: 'Mat4';
  readonly length: 16;
  readonly [index: number]: number;
}
```
This prevents callers from passing a raw `Float32Array` (or array of the wrong length, or arbitrary buffer) where a `Mat4` is expected — they would have to launder through `as unknown as Mat4`, which signals deliberate intent. The `readonly` indexer also prevents accidental writes to engine-vended matrices.

Internal kernels (`mat4Multiply`, `mat4Invert`, `packMat4IntoF32`, the allocator) operate on `Mat4Storage = Float32Array | Float64Array` — a raw typed-array union without brand, so the kernel can write freely. The two types describe the same memory; you cross between them at the trust boundary via `as unknown as Mat4Storage` / `as unknown as Mat4`.

New matrices are allocated via `allocateMat4()` from `_matrix-allocator.ts`, which returns `Float32Array(16)` by default and `Float64Array(16)` after `useHighPrecisionMatrix: true` is installed on the page (see `36-high-precision-matrix.md`).

## Shader Logic (Exact Math Formulas)

### Vec3 Operations

| Function | Formula |
|---|---|
| `addVec3(a, b)` | `{ x: a.x+b.x, y: a.y+b.y, z: a.z+b.z }` |
| `subVec3(a, b)` | `{ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }` |
| `scaleVec3(v, s)` | `{ x: v.x*s, y: v.y*s, z: v.z*s }` |
| `dotVec3(a, b)` | `a.x*b.x + a.y*b.y + a.z*b.z` |
| `crossVec3(a, b)` | `{ x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }` |
| `lengthVec3(v)` | `√(v.x² + v.y² + v.z²)` |
| `normalizeVec3(v)` | `v * (1/length)`, returns zero if `length < 1e-10` |
| `negateVec3(v)` | `{ x: -v.x, y: -v.y, z: -v.z }` |
| `lerpVec3(a, b, t)` | `{ x: a.x+(b.x-a.x)*t, y: a.y+(b.y-a.y)*t, z: a.z+(b.z-a.z)*t }` |
| `writeVec3(out, off, v)` | `out[off]=v.x; out[off+1]=v.y; out[off+2]=v.z` |

### mat4Multiply(a, b)

Standard column-major 4×4 matrix multiplication:
```
for col in 0..3:
  for row in 0..3:
    out[col*4+row] = a[row]*b[col*4] + a[4+row]*b[col*4+1] + a[8+row]*b[col*4+2] + a[12+row]*b[col*4+3]
```

### mat4LookAtLH(eye, target, up)

Left-handed look-at:
```
zAxis = normalize(target - eye)     // forward (into screen in LH)
xAxis = normalize(cross(up, zAxis)) // right
yAxis = cross(zAxis, xAxis)         // true up

out = | xAxis.x  xAxis.y  xAxis.z  -dot(xAxis, eye) |
      | yAxis.x  yAxis.y  yAxis.z  -dot(yAxis, eye) |
      | zAxis.x  zAxis.y  zAxis.z  -dot(zAxis, eye) |
      | 0        0        0         1                |
```
Column-major storage:
```
out[0]=xAxis.x  out[4]=xAxis.y  out[8]=xAxis.z   out[12]=-dot(xAxis,eye)
out[1]=yAxis.x  out[5]=yAxis.y  out[9]=yAxis.z   out[13]=-dot(yAxis,eye)
out[2]=zAxis.x  out[6]=zAxis.y  out[10]=zAxis.z  out[14]=-dot(zAxis,eye)
out[3]=0        out[7]=0        out[11]=0         out[15]=1
```
Returns identity if `|target - eye| < 1e-10` or `|cross(up, zAxis)| < 1e-10`.

### mat4PerspectiveLH(fov, aspect, near, far)

Left-handed perspective, depth range [0, 1]:
```
tan = 1 / Math.tan(fov * 0.5)
range = far - near

out[0]  = tan / aspect
out[5]  = tan
out[10] = far / range
out[11] = 1                    // LH: w_clip = +z_eye
out[14] = -(far * near) / range
out[15] = 0
```
All other elements are 0.

### mat4Invert(m)

Full cofactor expansion using 12 intermediate 2×2 determinants (`b00`–`b11`). Returns `null` if `|det| < 1e-10`.

Determinant:
```
det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06
```

Each element of the inverse is the corresponding cofactor divided by `det`.

### mat4Scale(x, y, z)

```
out = diag(x, y, z, 1) → out[0]=x, out[5]=y, out[10]=z, out[15]=1
```

### mat4Translation(x, y, z)

```
out = identity with out[12]=x, out[13]=y, out[14]=z
```

### mat4FromQuat(qx, qy, qz, qw)

```
xx=qx*qx  yy=qy*qy  zz=qz*qz
xy=qx*qy  xz=qx*qz  yz=qy*qz
wx=qw*qx  wy=qw*qy  wz=qw*qz

out[0]  = 1 - 2*(yy+zz)    out[4]  = 2*(xy-wz)       out[8]  = 2*(xz+wy)
out[1]  = 2*(xy+wz)         out[5]  = 1 - 2*(xx+zz)   out[9]  = 2*(yz-wx)
out[2]  = 2*(xz-wy)         out[6]  = 2*(yz+wx)        out[10] = 1 - 2*(xx+yy)
out[15] = 1
```

### mat4Compose(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz)

Computes `Translation × Rotation × Scale` in one step:
1. Build rotation from quaternion via `mat4FromQuat`.
2. Scale rotation columns: `col0 *= sx`, `col1 *= sy`, `col2 *= sz`.
3. Set translation: `rot[12]=tx`, `rot[13]=ty`, `rot[14]=tz`.

```
result[0..2]  = rotCol0 * sx    // column 0 (X axis)
result[4..6]  = rotCol1 * sy    // column 1 (Y axis)
result[8..10] = rotCol2 * sz    // column 2 (Z axis)
result[12..14] = (tx, ty, tz)   // column 3 (translation)
result[15] = 1
```

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `Vec3` interface | `BABYLON.Vector3` class |
| `Vec4` interface | `BABYLON.Vector4` class |
| `Color3` interface | `BABYLON.Color3` class |
| `Color4` interface | `BABYLON.Color4` class |
| `Mat4` (Float32Array) | `BABYLON.Matrix` (Float32Array `_m`) |
| `Quat` interface | `BABYLON.Quaternion` class |
| `vec3(x,y,z)` | `new BABYLON.Vector3(x,y,z)` |
| `addVec3(a,b)` | `a.add(b)` |
| `subVec3(a,b)` | `a.subtract(b)` |
| `crossVec3(a,b)` | `BABYLON.Vector3.Cross(a,b)` |
| `normalizeVec3(v)` | `BABYLON.Vector3.Normalize(v)` |
| `mat4Identity()` | `BABYLON.Matrix.Identity()` |
| `mat4Multiply(a,b)` | `a.multiply(b)` |
| `mat4LookAtLH(eye,target,up)` | `BABYLON.Matrix.LookAtLH(eye,target,up)` |
| `mat4PerspectiveLH(fov,ar,n,f)` | `BABYLON.Matrix.PerspectiveFovLH(fov,ar,n,f)` |
| `mat4Invert(m)` | `m.invert()` / `BABYLON.Matrix.Invert(m)` |
| `mat4FromQuat(qx,qy,qz,qw)` | `BABYLON.Matrix.FromQuaternion(q)` |
| `mat4Compose(t,r,s)` | `BABYLON.Matrix.Compose(scale,rotation,translation)` |
| Column-major layout | Column-major layout (same) |
| Left-handed | Left-handed (same) |
| Depth [0,1] | Depth [0,1] for WebGPU |

## Dependencies

- **No internal dependencies** — the core math module is a leaf module.
- **Depended on by**: Every other module (camera, scene, loaders, pipelines, materials).

## Test Specification

| Test | Description |
|---|---|
| `mat4Identity` | All diagonal elements = 1, rest = 0 |
| `mat4Multiply identity` | `A × I = A` |
| `mat4Multiply associativity` | `(A×B)×C ≈ A×(B×C)` within epsilon |
| `mat4LookAtLH basic` | Eye at (0,0,-5), target (0,0,0): verify zAxis = (0,0,1) |
| `mat4PerspectiveLH` | Verify `m[0] = tan/aspect`, `m[10] = far/(far-near)` |
| `mat4Invert × m = identity` | Verify `m × m⁻¹ ≈ I` |
| `mat4Invert returns null for singular` | Zero matrix → null |
| `mat4FromQuat identity` | Quat (0,0,0,1) → identity matrix |
| `mat4FromQuat 90° around Y` | Verify correct rotation |
| `mat4Compose T×R×S` | Compare with manual multiply of separate matrices |
| `normalizeVec3 zero` | Returns (0,0,0) for zero vector |
| `crossVec3 X×Y=Z` | (1,0,0) × (0,1,0) = (0,0,1) |
| `lerpVec3 t=0 and t=1` | Returns a and b respectively |
| `writeVec3` | Verify Float32Array written at correct offset |
| `Mat4 brand` | Ensure typed as Float32Array with length 16 |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/core/types.ts` | ~44 lines | Type definitions (Vec3, Vec4, Color3, Color4, Mat4, Quat) |
| `src/core/vec3.ts` | ~68 lines | Vec3 constructors, constants, arithmetic |
| `src/core/mat4.ts` | ~185 lines | Mat4 identity, multiply, lookAt, perspective, invert, TRS |
| `src/core/index.ts` | ~11 lines | Barrel re-exports |
| `src/core/generate-mipmaps.ts` | ~141 lines | GPU mipmap generation (used by loaders, not math) |
