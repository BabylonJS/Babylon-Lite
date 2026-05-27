# Module: Scene Hierarchy & Parenting
> Package path: `packages/babylon-lite/src/scene/`

## Purpose

Live parent-child hierarchy where **any entity** (TransformNode, Mesh, Camera, Light)
can be parented to any other via two interfaces: `IWorldMatrixProvider` (parent contract)
and `IParentable` (child contract). World matrices propagate lazily via version-based
caching — O(1) for static scenes, O(depth) for dynamic changes.

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
`getViewMatrix()` and `getPosition()` derive from `worldMatrix`.

### Lights

`LightBase` extends `IWorldMatrixProvider, IParentable`. All 4 light types
(point, directional, spot, hemispheric) use `createWorldMatrixState` with
push-based dirty tracking via `ObservableVec3`.

UBO writers read world-space values from `worldMatrix` columns:
- Position = column 3: `[w[12], w[13], w[14]]`
- Direction = column 2: `[w[8], w[9], w[10]]`

---

## Internal Architecture

### Shared World Matrix Helper (`scene/world-matrix-state.ts`)

```typescript
function createWorldMatrixState(getLocalMatrix: () => Mat4): WorldMatrixAccessors;
```

Factory that returns `{ getWorldMatrix, getWorldMatrixVersion, markLocalDirty, parent }`.
Each entity provides a `getLocalMatrix()` closure. The helper handles:
- Version tracking (`_localVersion`, `_worldVersion`, `_lastParentVersion`)
- Parent chain validation (recursive `parent.worldMatrix` call)
- Caching with `mat4MultiplyInto` for GC-free buffer reuse

### Push-Based Dirty Tracking

All entities use push-based dirty notification — no polling or `checkDirty()` functions:

| Entity | Property | Mechanism |
|--------|----------|-----------|
| TransformNode | position/scaling | `ObservableVec3` → `markLocalDirty()` |
| TransformNode | rotationQuaternion | `ObservableQuat` → `markLocalDirty()` |
| Mesh | position/rotation/scaling | `ObservableVec3` → `markLocalDirty()` |
| ArcRotateCamera | alpha/beta/radius | `Object.defineProperty` setter → `markLocalDirty()` |
| ArcRotateCamera | target | `ObservableVec3` → `markLocalDirty()` |
| FreeCamera | position/target | `ObservableVec3` → `markLocalDirty()` |
| FreeCamera | _yaw/_pitch | `Object.defineProperty` setter → `markLocalDirty()` |
| All lights | position/direction | `ObservableVec3` → `markLocalDirty()` |

### `ObservableQuat` (`math/observable-quat.ts`)

Same pattern as `ObservableVec3` but with 4 components (x,y,z,w). Used for
`TransformNode.rotationQuaternion`. Fires `onDirty` callback on any component change.

### Light Matrix Helper (`light/light-matrix.ts`)

```typescript
function localMatrixFromDirection(dx, dy, dz, px?, py?, pz?): Mat4;
```

Builds an orthonormal basis from a direction vector. Column 2 = forward (normalized direction).
Used by directional, spot, and hemispheric lights. Inlines `Float32Array(16)` to avoid
importing `mat4Identity`.

---

## Version-Based Lazy Algorithm

```
get worldMatrix():
    if cached AND localVersion unchanged:
        if no parent → return cached           ← O(1)
        walk parent chain (triggers lazy recompute)
        if parent version unchanged → return cached  ← O(1)

    local = getLocalMatrix()
    if parent:
        cached = mat4Multiply(parent.worldMatrix, local)  // mat4MultiplyInto if cached exists
    else:
        cached = local

    update version snapshots
    worldVersion++
    return cached
```

### Performance characteristics

| Scenario | Cost per frame |
|----------|---------------|
| Static scene (no changes) | O(1) per entity — integer comparison |
| Root changes, N descendants | O(N) — each descendant recomputes once |
| Single leaf changes | O(depth) — walk to root, recompute back down |

---

## Scene Integration

### `addToScene(scene, TransformNode)`

```typescript
if (isTransformNode(entity)) {
    const meshes = collectMeshes(entity, entity.parent ?? undefined);
    for (const m of meshes) { ctx.add(m); }
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

| File | Status | Description |
|------|--------|-------------|
| `scene/parentable.ts` | New | IWorldMatrixProvider + IParentable interfaces |
| `scene/world-matrix-state.ts` | New | createWorldMatrixState factory |
| `math/observable-quat.ts` | New | ObservableQuat class |
| `light/light-matrix.ts` | New | localMatrixFromDirection helper |
| `loader-gltf/gltf-animation.ts` | New | Lazy-loaded animation/skin parsing |
| `scene/transform-node.ts` | Rewritten | createTransformNode, unified children |
| `mesh/mesh.ts` | Modified | Removed computeWorldMatrix, added IWorldMatrixProvider |
| `camera/arc-rotate.ts` | Modified | Added IWorldMatrixProvider, push-based dirty |
| `camera/free-camera.ts` | Modified | Added IWorldMatrixProvider, push-based dirty |
| `light/types.ts` | Modified | LightBase extends IWorldMatrixProvider |
| `light/point-light.ts` | Modified | ObservableVec3 position, createWorldMatrixState |
| `light/directional-light.ts` | Modified | ObservableVec3 position/direction |
| `light/spot-light.ts` | Modified | ObservableVec3 position/direction |
| `light/hemispheric.ts` | Modified | ObservableVec3 direction |
| `scene/scene-core.ts` | Modified | addToScene() sets parent links via collectMeshes |
| `loader-gltf/load-gltf.ts` | Modified | Uses createTransformNode, lazy animation |
| `index.ts` | Modified | Exports IWorldMatrixProvider, IParentable, ObservableQuat |

---

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|-------------|-----------|
| `IWorldMatrixProvider` | `Node` (has `getWorldMatrix()`) |
| `IParentable` | `Node.parent` property |
| `mesh.parent = node` | `mesh.parent = node` |
| `mesh.worldMatrix` (getter) | `mesh.getWorldMatrix()` |
| `mesh.worldMatrixVersion` | `mesh._currentRenderId` |
| `createTransformNode(name)` | `new TransformNode(name, scene)` |
| `node.position.set(x, y, z)` | `node.position = new Vector3(x, y, z)` |
| `node.children` | `node.getChildren()` |
| Lazy pull model | Push model (`_markAsDirty`) |
| Version-based staleness | Frame-based `_currentRenderId` check |
