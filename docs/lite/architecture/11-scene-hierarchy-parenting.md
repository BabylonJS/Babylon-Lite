# Module: Scene Hierarchy & Parenting

> Package path: `packages/babylon-lite/src/scene/`

## Purpose

Live parent-child hierarchy where **any entity** (TransformNode, Mesh, Camera, Light)
can be parented to any other via two interfaces: `IWorldMatrixProvider` (parent contract)
and `IParentable` (child contract). Transform writes push version invalidation through
the subtree; matrix composition remains lazy. Unchanged engine-node reads are O(1).

---

## Public API Surface

### Interfaces (`scene/parentable.ts`)

```typescript
interface IWorldMatrixProvider {
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

interface IParentable {
    parent: IWorldMatrixProvider | null;
}
```

Zero runtime code — interfaces are erased at compile time.

### Reparenting (`scene/set-parent.ts`)

```typescript
// Reparent while preserving world-space transform (Babylon.js TransformNode.setParent).
// Accepts any SceneNode (mesh, transform node, camera, light), not just Mesh.
export function setParent(child: SceneNode, parent: IWorldMatrixProvider | null): void;
```

`setParent` snapshots the child's world matrix, sets `child.parent`, then writes back the
local TRS (via `decomposeMat4`, so the rotation is a quaternion — no lossy Euler round-trip).
It also keeps the scene-graph `children` arrays in sync: the child is removed from its old
parent's `children` and appended to the new parent's, so traversal helpers (`setMeshVisible`
cascade, cloning, camera bounds) see the new hierarchy. Setting `child.parent` directly drives
the transform math but does **not** touch `children` — push manually if you need traversal too.

**Mirrored children are preserved.** The glTF loader's synthetic `__root__` carries the RH→LH
handedness flip as `scaling = (-1, 1, 1)`, so its local transform has a negative determinant.
`decomposeMat4` keeps that reflection (folded onto a negative Y scale, as Babylon.js does), so
reparenting a loaded model under a user-created transform node renders identically to before.

**Matrix-backed nodes are reparented too.** A node created with `createSceneNodeFromMatrix` (used
for glTF nodes that declare a raw `matrix` instead of TRS) reports that matrix as its local
transform and ignores `position`/`rotationQuaternion`/`scaling`. `setParent` clears `_localMatrix`
and writes the decomposed TRS instead, handing control back to the TRS triple — the decomposition
reproduces exactly the matrix it replaces, so the node does not move beyond the reparent itself.

**Parent links come from `addToScene`.** The glTF loader fills `children` arrays but leaves `parent`
unset; `addToScene` walks the tree and assigns it. `setParent` needs the real parent chain to read a
node's world transform, so reparent a _nested_ loaded node only after its container has been added.
Reparenting the container's own root beforehand is fine — its parent is null either way.

### TransformNode (`scene/transform-node.ts`)

```typescript
interface TransformNode extends IWorldMatrixProvider, IParentable {
    name: string;
    position: ObservableVec3;
    rotationQuaternion: ObservableQuat;
    scaling: ObservableVec3;
    children: (TransformNode | Mesh)[];
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

function createTransformNode(name, px, py, pz, qx, qy, qz, qw, sx, sy, sz): TransformNode;
function cloneTransformNode(src: TransformNode): TransformNode;
function collectMeshes(node: TransformNode, parentProvider?: IWorldMatrixProvider): Mesh[];
function isTransformNode(obj: unknown): obj is TransformNode;
```

### Mesh (`mesh/mesh.ts`)

```typescript
interface Mesh extends IWorldMatrixProvider, IParentable {
    // ... existing fields ...
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}
```

`computeWorldMatrix()` is removed. All call sites use `mesh.worldMatrix` directly.
`MeshGPU.worldMatrix` is removed — caching lives in `createWorldMatrixState` closure.
`mesh._transformVersion` is removed — replaced by `worldMatrixVersion`.

### Cameras

Both `ArcRotateCamera` and `FreeCamera` extend `IWorldMatrixProvider, IParentable`.
Camera `worldMatrix` is the camera-to-world transform (inverse of view matrix).
`getViewMatrix(camera)` and `getCameraPosition(camera)` derive from `worldMatrix`.

### Lights

`LightBase` extends `SceneNode`. All 4 light types (point, directional, spot,
hemispheric) therefore expose the standard position, quaternion/Euler rotation,
scaling, parent, children, and world-matrix state. Setting a light's local `direction`
updates its lighting data, while direct SceneNode rotation writes orient that local
direction through the world matrix. `setParent` uses the same path for lights and every other SceneNode,
including normal child-array traversal. Light UBO and shadow consumers read the world
matrix, so ancestor motion and scaling affect both paths consistently.

UBO writers read world-space values from `worldMatrix` columns:

- Position = column 3: `[w[12], w[13], w[14]]`
- Direction = normalized `worldMatrix * localDirection` (with `w = 0`)

---

## Internal Architecture

### Shared World Matrix Helper (`scene/world-matrix-state.ts`)

```typescript
function createWorldMatrixState(getLocalMatrix: () => Mat4): WorldMatrixAccessors;
```

Factory that returns `{ getWorldMatrix, getWorldMatrixVersion, markLocalDirty, parent }`.
Each entity provides a `getLocalMatrix()` closure. The helper owns:

- `_worldVersion`, bumped on every local write, ancestor invalidation or reparent.
- `_cachedLocal`, the latest local matrix, cleared only by `markLocalDirty()`.
- `_cachedWorld`, cleared by either local or world invalidation.
- `_ownedWorld`, allocated once through `allocateMat4()` and reused by
  `multiplyMat4IntoBuffer` for parented results.
- A private child registry maintained by the `parent` setter independently of the
  host's public `children` array. A symbol attached by `attachWorldMatrixState`
  identifies engine parents and connects their invalidation state.
- `_lastSeenParentVersion`, used only to poll a direct foreign parent (a provider
  without that symbol). Reads of either the world matrix or version poll that
  parent's public version and push world-only invalidation if it changed.

`markLocalDirty()` clears the local cache, then unconditionally invalidates the node
and every descendant's world cache/version. `_invalidate()` is world-only: ancestor
motion and reparenting do not change the node's local transform. Neither traversal
may stop at an already-dirty node: a consumer may read only a leaf version while
intermediate nodes remain unread across successive ancestor moves.

`_markWorldMatrixDirty(host)` conservatively calls `markLocalDirty()`. Its callers
include the banked camera's mutable up vector, which changes the local look-at basis
without writing position/rotation/scaling. Treating this hook as world-only would
incorrectly retain that basis.

### SceneNode local storage (`scene/scene-node.ts`)

`initSceneNodeTransform` lazily allocates one private TRS matrix through `allocateMat4()`.
Its local factory fills that matrix with
`composeTrsLocalMatrixIntoBuffer(local: Mat4Storage, position: Vec3, rotation: Quat, scaling: Vec3): void`
only when the shared local cache is invalid; subsequent local edits reuse the same storage.
This writer uses `composeMat4IntoBuffer` for nonidentity TRS. For the default transform
it fills the storage with zero and writes diagonal ones, preserving the existing fast
path and signed-zero normalization without allocating. Parent-only
movement/reparenting neither recomposes nor allocates a local matrix. Storage is F32
by default and F64 when the HPM allocator is installed before node creation/use.

An explicit `_localMatrix` takes precedence without composing or mutating its values.
Locked glTF matrices still ignore TRS writes; unlocked TRS writes clear the override
and invalidate the local cache. `setParent` seeds TRS and preserves the exact affine
matrix using its existing path, including shear/reflections.

`worldMatrix` is borrowed read-only storage, not a snapshot: copy its values if they
must survive future matrix reads after an edit. Root nodes return their local matrix;
parented nodes return `_ownedWorld`. No public factory changes its ownership contract:
`composeMat4` and `composeTrsLocalMatrix` still return fresh independent matrices.
The latter allocates once and delegates to the shared TRS writer.

### Push-Based Dirty Tracking

Engine entities use push-based dirty notification; direct foreign parents retain the
version-polling fallback described above:

| Entity          | Property                  | Mechanism                                           |
| --------------- | ------------------------- | --------------------------------------------------- |
| TransformNode   | position/scaling          | `ObservableVec3` → `markLocalDirty()`               |
| TransformNode   | rotationQuaternion        | `ObservableQuat` → `markLocalDirty()`               |
| Mesh            | position/rotation/scaling | `ObservableVec3` → `markLocalDirty()`               |
| ArcRotateCamera | alpha/beta/radius         | `Object.defineProperty` setter → `markLocalDirty()` |
| ArcRotateCamera | target                    | `ObservableVec3` → `markLocalDirty()`               |
| FreeCamera      | position/target           | `ObservableVec3` → `markLocalDirty()`               |
| FreeCamera      | \_yaw/\_pitch             | `Object.defineProperty` setter → `markLocalDirty()` |
| All lights      | position/direction        | `ObservableVec3` → `markLocalDirty()`               |

### `ObservableQuat` (`math/observable-quat.ts`)

Same pattern as `ObservableVec3` but with 4 components (x,y,z,w). Used for
`TransformNode.rotationQuaternion`. Fires `onDirty` callback on any component change.

### Light Matrix Helper (`light/light-matrix.ts`)

```typescript
function localMatrixFromDirection(dx, dy, dz, px?, py?, pz?): Mat4;
```

Builds an orthonormal basis from a direction vector. Column 2 = forward (normalized direction).
Used by directional, spot, and hemispheric lights. Inlines `Float32Array(16)` to avoid
importing `createIdentityMat4`.

---

## Version-Based Lazy Algorithm

```
get worldMatrix():
    poll direct foreign parent, if any
    if cachedWorld exists → return cachedWorld
    if cachedLocal is null → cachedLocal = getLocalMatrix()
    if parent:
        multiplyMat4IntoBuffer(ownedWorld, parent.worldMatrix, cachedLocal)
        cachedWorld = ownedWorld
    else:
        cachedWorld = cachedLocal
    return cachedWorld
```

### Performance characteristics

| Scenario                    | Cost per frame                               |
| --------------------------- | -------------------------------------------- |
| Static scene (no changes)   | O(1) per entity — cached matrix/version read |
| Root changes, N descendants | O(N) version push; lazy world products, only root local composition |
| Single leaf changes         | O(1) invalidation; one local composition/product against cached parent |

These structural costs are not universal performance measurements. The CPU benefit
depends on hierarchy shape, local versus ancestor movement, and matrix precision.
Required world products and unconditional descendant version propagation remain.

### Focused Test Specification

`tests/lite/unit/world-matrix-parent-propagation.test.ts` separates compatibility
assertions (must pass before/after) from optimization assertions (expected red before):
local TRS edits, repeated ancestor movement through unread intermediates, direct foreign
parent polling, reparent/detach, explicit local invalidation, raw matrix hand-off, F32/F64
values and fresh math-factory outputs. Spies on the existing allocator/composition kernel
and supplied local factories prove storage/composition reuse without runtime counters.
`engine-matrix-policy`, `banked-free-camera`, `mat4-decompose-mirrored` and `light-parenting`
tests cover the related precision, local look-at invalidation and affine consumers.

---

## Scene Integration

### `addToScene(scene, TransformNode)`

```typescript
if (isTransformNode(entity)) {
    const meshes = collectMeshes(entity, entity.parent ?? undefined);
    for (const m of meshes) {
        ctx.add(m);
    }
}
```

`collectMeshes` recursively walks `children`, sets `parent` links on each child,
and returns all `Mesh` leaves. Meshes land in `scene.meshes[]` for flat rendering iteration.
The hierarchy persists via `parent` pointers.

### glTF Loader

`buildNodeHierarchy()` uses `createTransformNode()` and pushes both child TransformNodes
and Meshes into the unified `children` array. Parent links are set by `collectMeshes`
when the tree is added to the scene.

Animation/skin parsing is lazy-loaded via `gltf-animation.ts` for bundle size optimization.

---

## File Manifest

| File                            | Status    | Description                                               |
| ------------------------------- | --------- | --------------------------------------------------------- |
| `scene/parentable.ts`           | New       | IWorldMatrixProvider + IParentable interfaces             |
| `scene/world-matrix-state.ts`   | New       | createWorldMatrixState factory                            |
| `math/observable-quat.ts`       | New       | ObservableQuat class                                      |
| `light/light-matrix.ts`         | New       | localMatrixFromDirection helper                           |
| `loader-gltf/gltf-animation.ts` | New       | Lazy-loaded animation/skin parsing                        |
| `scene/transform-node.ts`       | Rewritten | createTransformNode, unified children                     |
| `mesh/mesh.ts`                  | Modified  | Removed computeWorldMatrix, added IWorldMatrixProvider    |
| `camera/arc-rotate.ts`          | Modified  | Added IWorldMatrixProvider, push-based dirty              |
| `camera/free-camera.ts`         | Modified  | Added IWorldMatrixProvider, push-based dirty              |
| `light/types.ts`                | Modified  | LightBase extends IWorldMatrixProvider                    |
| `light/point-light.ts`          | Modified  | ObservableVec3 position, createWorldMatrixState           |
| `light/directional-light.ts`    | Modified  | ObservableVec3 position/direction                         |
| `light/spot-light.ts`           | Modified  | ObservableVec3 position/direction                         |
| `light/hemispheric.ts`          | Modified  | ObservableVec3 direction                                  |
| `scene/scene-core.ts`           | Modified  | addToScene() sets parent links via collectMeshes          |
| `loader-gltf/load-gltf.ts`      | Modified  | Uses createTransformNode, lazy animation                  |
| `index.ts`                      | Modified  | Exports IWorldMatrixProvider, IParentable, ObservableQuat |

---

## Babylon.js Equivalence Map

| Babylon Lite                 | Babylon.js                             |
| ---------------------------- | -------------------------------------- |
| `IWorldMatrixProvider`       | `Node` (has `getWorldMatrix()`)        |
| `IParentable`                | `Node.parent` property                 |
| `mesh.parent = node`         | `mesh.parent = node`                   |
| `mesh.worldMatrix` (getter)  | `mesh.getWorldMatrix()`                |
| `mesh.worldMatrixVersion`    | `mesh._currentRenderId`                |
| `createTransformNode(name)`  | `new TransformNode(name, scene)`       |
| `node.position.set(x, y, z)` | `node.position = new Vector3(x, y, z)` |
| `node.children`              | `node.getChildren()`                   |
| Lazy pull model              | Push model (`_markAsDirty`)            |
| Version-based staleness      | Frame-based `_currentRenderId` check   |
