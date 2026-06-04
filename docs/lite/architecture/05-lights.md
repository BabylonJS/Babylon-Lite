# Module: Lights
> Package path: `packages/babylon-lite/src/light/`

## Purpose

Provides plain-data light definitions for **hemispheric**, **directional**, **point**, and **spot** light types, plus a shared infrastructure layer (`light-base.ts`, `light-matrix.ts`, `types.ts`) and a scene-owned lights UBO packing system (`render/lights-ubo.ts`, `scene/scene-light-state.ts`). Following Babylon Lite's "pillar 4b" principle, lights are stateless data objects with no scene references.

Factory functions create light objects with sensible defaults; callers add them to scenes or pass them to material setup functions. Each light carries:
- Push-based dirty tracking via `ObservableVec3` for positions/directions
- World-matrix state with parent support (inherited from `light-base.ts`)
- Shared UBO writer (`_writeLightUbo`) for the scene lights UBO system
- Version tracking (`_lightVersion`) so per-frame light uploads can be guarded

PBR no longer uses per-light extension registration or light fields in `SceneUniforms`. Standard, PBR, and NodeMaterial consume the scene-owned `LightsUniforms` UBO at `@group(0) @binding(1)`. Per-mesh UBOs carry material-independent light selection (`lc` plus packed `li: array<vec4<u32>, ceil(MAX_LIGHTS / 4)>`) computed from `LightBase.includedOnlyMeshIds` / `excludedMeshIds`; shaders index the scene lights array through those mesh indices. Exactly one eligible non-shadow PBR light uses `material/pbr/fragments/singlelight-wgsl.ts`; multiple lights or any shadow receiver use `material/pbr/fragments/multilight-wgsl.ts`.

---

## Public API Surface

### Shared Types (`types.ts`)

```typescript
/** Shared base for all light types. Provides pipeline integration callbacks. */
export interface LightBase extends IWorldMatrixProvider, IParentable {
  readonly lightType: string;
  children: SceneNode[];
  excludedMeshIds?: ReadonlySet<string>;
  includedOnlyMeshIds?: ReadonlySet<string>;
  shadowGenerator?: ShadowGenerator;
  parent: IWorldMatrixProvider | null;
  readonly worldMatrix: Mat4;
  readonly worldMatrixVersion: number;
}

/** @internal */
export interface LightBaseInternal extends LightBase {
  readonly _writeLightUbo?: (data: Float32Array, offset: number) => void;
  readonly _lightVersion: number;
}

export let MAX_LIGHTS = 16;
export function setMaxLights(n: number): void;
export const LIGHT_ENTRY_FLOATS = 16;  // 4 × vec4 = 64 bytes per light
```

### Light Base (`light-base.ts`)

```typescript
/** Create world-matrix state + dirty callback shared by all light types. */
export function createLightBase(getLocalMatrix: () => Mat4): {
  wm: WorldMatrixAccessors;
  onDirty: () => void;
};

/** Mixin world-matrix accessors (parent, worldMatrix, worldMatrixVersion) onto a light object. */
export function applyWorldMatrixAccessors<R>(target: object, wm: WorldMatrixAccessors): R;

export { ObservableVec3 } from '../math/observable-vec3.js';
```

### Light Matrix Helper (`light-matrix.ts`)

```typescript
/** Build a local matrix from a direction vector + optional position.
 *  Column 2 = forward (normalized direction), column 0 = right, column 1 = up. */
export function localMatrixFromDirection(
  dx: number, dy: number, dz: number,
  px?: number, py?: number, pz?: number,
): Mat4;
```

**Algorithm:**
1. Normalize direction: `forward = normalize(dx, dy, dz)`
2. Compute `right = normalize(cross((0,1,0), forward))` (simplified: `right = (-fz, 0, fx)`)
3. Compute `up = cross(forward, right)`
4. Build column-major 4×4 matrix: col0=right, col1=up, col2=forward, col3=position
5. `m[15] = 1`

### Directional Light (`directional-light.ts`)

```typescript
export interface DirectionalLight extends LightBase {
  readonly lightType: 'directional';
  direction: ObservableVec3;
  position: ObservableVec3;
  diffuse: [number, number, number];
  specular: [number, number, number];
  intensity: number;
}

export function createDirectionalLight(
  direction: [number, number, number],
  intensity?: number,   // Default: 1
): DirectionalLight;
```

**Default values:**
| Property   | Default        |
|------------|----------------|
| lightType  | `'directional'`|
| direction  | *(parameter)*  |
| position   | `(0, 0, 0)` via ObservableVec3 |
| diffuse    | `[1, 1, 1]`   |
| specular   | `[1, 1, 1]`   |
| intensity  | `1`            |

### Point Light (`point-light.ts`)

```typescript
export interface PointLight extends LightBase {
  readonly lightType: 'point';
  position: ObservableVec3;
  diffuse: [number, number, number];
  specular: [number, number, number];
  intensity: number;
  range: number;
}

export function createPointLight(
  position: [number, number, number],
  intensity?: number,   // Default: 1.0
): PointLight;
```

**Default values:**
| Property   | Default              |
|------------|----------------------|
| lightType  | `'point'`            |
| position   | *(parameter)* via ObservableVec3 |
| diffuse    | `[1, 1, 1]`         |
| specular   | `[1, 1, 1]`         |
| intensity  | `1.0`                |
| range      | `Number.MAX_VALUE`   |

**Local matrix:** `mat4Translation(position.x, position.y, position.z)` — position only, no orientation.

### Hemispheric Light (`hemispheric.ts`)

```typescript
export interface HemisphericLight extends LightBase {
  readonly lightType: 'hemispheric';
  direction: ObservableVec3;
  intensity: number;
  diffuseColor: [number, number, number];
  specularColor: [number, number, number];
  groundColor: [number, number, number];
}

export function createHemisphericLight(
  direction?: [number, number, number],   // Default: [0, 1, 0]
  intensity?: number,                      // Default: 1.0
): HemisphericLight;
```

**Default values:**
| Property     | Default        |
|--------------|----------------|
| lightType    | `'hemispheric'`|
| direction    | `(0, 1, 0)` via ObservableVec3 |
| intensity    | `1.0`          |
| diffuseColor | `[1, 1, 1]`   |
| specularColor | `[1, 1, 1]` |
| groundColor  | `[0, 0, 0]`   |

### Spot Light (`spot-light.ts`)

```typescript
export interface SpotLight extends LightBase {
  readonly lightType: 'spot';
  position: ObservableVec3;
  direction: ObservableVec3;
  /** Full cone angle in radians. */
  angle: number;
  /** Falloff exponent — higher = sharper spotlight. */
  exponent: number;
  diffuse: [number, number, number];
  specular: [number, number, number];
  intensity: number;
  range: number;
}

export function createSpotLight(
  position: [number, number, number],
  direction: [number, number, number],
  angle: number,
  exponent: number,
  intensity?: number,   // Default: 1.0
): SpotLight;
```

**Default values:**
| Property   | Default              |
|------------|----------------------|
| lightType  | `'spot'`             |
| position   | *(parameter)* via ObservableVec3 |
| direction  | *(parameter)* via ObservableVec3 |
| angle      | *(parameter)*        |
| exponent   | *(parameter)*        |
| diffuse    | `[1, 1, 1]`         |
| specular   | `[1, 1, 1]`         |
| intensity  | `1.0`                |
| range      | `Number.MAX_VALUE`   |

**Local matrix:** Uses `localMatrixFromDirection(direction, position)` — both orientation and position.

---

## Internal Architecture

### Data Structures

All lights are plain JavaScript objects (POJOs) with `Object.defineProperties`-based world-matrix accessors — no classes, no GPU resources. The scene owns one GPU `LightsUniforms` buffer for `scene.lights`; materials only declare/read the fixed group-0 binding.

### Light Base Infrastructure (`light-base.ts`)

Every light factory:
1. Calls `createLightBase(getLocalMatrix)` which returns `{ wm, onDirty }`:
   - `wm`: `WorldMatrixAccessors` — provides `getWorldMatrix()`, `getWorldMatrixVersion()`, `markLocalDirty()`, and `parent` get/set
   - `onDirty`: callback that calls `wm.markLocalDirty()` — passed to `ObservableVec3` constructors
2. Builds the light data object with an `_writeLightUbo` callback
3. Calls `applyWorldMatrixAccessors(target, wm)` which uses `Object.defineProperties` to add `parent`, `worldMatrix`, and `worldMatrixVersion` as getters/setters

This pattern eliminates duplicated world-matrix boilerplate across all light types.

### Light Type Discrimination (Standard Material)

Each light writes its type flag at `data[offset + 3]` in `_writeLightUbo`:

| `vLightData.w` | Light Type   | Position/Direction Source |
|-----------------|-------------|--------------------------|
| `0`             | Point       | xyz = world position (worldMatrix col 3) |
| `1`             | Directional | xyz = world direction (worldMatrix col 2) |
| `2`             | Spot        | xyz = world position (worldMatrix col 3) |
| `3`             | Hemispheric | xyz = world direction (worldMatrix col 2) |

### Lights UBO Layout (`render/lights-ubo.ts`)

Standard, PBR, and NodeMaterial pipelines use a shared scene lights UBO supporting up to `MAX_LIGHTS = 16` packed scene lights by default. `setMaxLights(n)` may adjust the cap before pipelines/UBOs are created. Unlike Babylon.js's default `maxSimultaneousLights = 4` per material, Babylon Lite's `MAX_LIGHTS` is the total scene-wide packed-light capacity.

The frame/pass bind group layout is:

| Group | Binding | Owner | Contents |
|-------|---------|-------|----------|
| 0 | 0 | `RenderTask` | Per-pass `SceneUniforms` (camera, fog, image processing, environment) |
| 0 | 1 | `SceneContextInternal` via `scene-light-state.ts` | Scene-wide `LightsUniforms` packed from `scene.lights` |

Material/mesh bind groups never contain light buffers. Mesh UBOs append:

```wgsl
lc: u32,
li: array<vec4<u32>, ceil(MAX_LIGHTS / 4)>,
```

Each packed index addresses `lights.lights[index]` in the scene-wide UBO (`li[i / 4u][i % 4u]`). `render/lights-ubo.ts` computes this list per mesh by skipping lights whose `includedOnlyMeshIds` excludes the mesh or whose `excludedMeshIds` includes it.

**Default total UBO size:** `getLightsUboSize() = 16 + MAX_LIGHTS × 64` bytes (1040 bytes when `MAX_LIGHTS = 16`)

**Layout:**

| Offset (bytes) | Size   | Content                          |
|-----------------|--------|----------------------------------|
| 0–3             | 4B     | `count` (u32) — number of active lights |
| 4–15            | 12B    | padding (3 × u32)               |
| 16–79           | 64B    | Light 0 entry (4 × vec4)        |
| 80–143          | 64B    | Light 1 entry (4 × vec4)        |
| 144–207         | 64B    | Light 2 entry (4 × vec4)        |
| 208–271         | 64B    | Light 3 entry (4 × vec4)        |

**Per-light entry layout (LIGHT_ENTRY_FLOATS = 16, 64 bytes):**

| Float Index | Directional (w=1) | Point (w=0) | Spot (w=2) | Hemispheric (w=3) |
|-------------|-------------------|-------------|------------|-------------------|
| [0–2]       | direction (col2)  | position (col3) | position (col3) | direction (col2) |
| [3]         | 1 (type flag)     | 0 (type flag) | 2 (type flag) | 3 (type flag) |
| [4–6]       | diffuse × intensity | diffuse × intensity | diffuse × intensity | diffuseColor × intensity |
| [7]         | MAX_VALUE (range) | range | range | *(unused)* |
| [8–10]      | specular × intensity | specular × intensity | specular × intensity | specularColor × intensity |
| [11]        | *(unused)*        | *(unused)* | exponent | *(unused)* |
| [12–14]     | *(unused)*        | *(unused)* | direction (col2) | groundColor × intensity |
| [15]        | *(unused)*        | *(unused)* | cos(angle/2) | *(unused)* |

### UBO Functions (`lights-ubo.ts`)

```typescript
/** Fill a Float32Array with standard light data. */
export function fillLightsData(data: Float32Array, lights: readonly LightBase[]): void;

/** Current lights UBO byte size for the active MAX_LIGHTS value. */
export function getLightsUboSize(): number;

/** Create a new lights UBO from all compatible lights. */
export function writeLightsUBO(engine: EngineContextInternal, lights: readonly LightBase[]): GPUBuffer;

/** Refresh an existing lights UBO with current light state. */
export function refreshLightsUBO(
  engine: EngineContextInternal,
  buffer: GPUBuffer,
  lights: readonly LightBase[],
  scratch: Float32Array,
): void;
```

**`fillLightsData` algorithm:**
1. Zero the entire Float32Array
2. Iterate lights, skip those without `_writeLightUbo`, stop at `MAX_LIGHTS`
3. Call each light's `_writeLightUbo(data, headerFloats + count * LIGHT_ENTRY_FLOATS)`
4. Write `count` into the first u32 slot via `Uint32Array` view

### PBR Light Shader Paths

PBR materials consume the same packed `LightEntry` layout as Standard materials. The PBR renderable builder decides which WGSL helper to import once per scene:

| Condition | WGSL helper | Behavior |
|-----------|-------------|----------|
| Mesh has exactly one eligible light and no shadow receiver path | `material/pbr/fragments/singlelight-wgsl.ts` | Non-looping direct-light code specialized by that light's `lightType`; reads `lights.lights[mli(0u)]` |
| Mesh has multiple eligible lights, or any shadow receiver path | `material/pbr/fragments/multilight-wgsl.ts` | Generic `computePbrLight()` + loop over `mesh.lc`; shadow fragment writes per-scene-light shadow factors |

Supported PBR light types are hemispheric, directional, point, and spot. PBR materials default to physical inverse-square point/spot falloff. Materials with `usePhysicalLightFalloff: false` use Babylon's Standard-style falloff instead: linear range attenuation plus spot cone exponent attenuation.

### Shader Lighting Math (Standard Material)

(Defined in `standard-textured.fragment.wgsl`, consumed via lights UBO)

**Point light attenuation:**
```
direction = lightPosition - fragmentPosition
attenuation = max(0, 1 - length(direction) / range)
lightVector = normalize(direction)
```

**Directional light:**
```
lightVector = normalize(-lightDirection)
attenuation = 1.0
```

**Spot light attenuation:**
```
lightVector = normalize(lightPosition - fragmentPosition)
attenuation = max(0, 1 - length(lightPosition - fragmentPosition) / range)
cosAngle = dot(normalize(lightDirection), -lightVector)
spotFalloff = max(0, cosAngle - cosHalfAngle) ^ exponent
attenuation *= spotFalloff
```

**Hemispheric light:**
```
lightVector = normalize(lightDirection)
NdotL = dot(normal, lightVector) * 0.5 + 0.5  // wrapped diffuse
diffuse = mix(groundColor, diffuseColor, NdotL) * intensity
```

**Diffuse (Lambertian):**
```
ndl = max(0, dot(normal, lightVector))
diffuse = ndl * lightDiffuseColor * attenuation
```

**Specular (Blinn-Phong):**
```
halfVector = normalize(viewDir + lightVector)
specComp = pow(max(0, dot(normal, halfVector)), max(1, glossiness))
specular = specComp * lightSpecularColor * attenuation
```

---

## Pipeline Configuration

Light modules do not create GPU pipelines. They produce plain data consumed by material pipelines.

The lights UBO (`render/lights-ubo.ts`) creates a single `GPUBuffer` with `UNIFORM | COPY_DST` usage. `SceneContextInternal._lightGpuState` stores it on the scene, refreshes it per-frame through `refreshSceneLightsUBO()`, and recreates it if the active `MAX_LIGHTS` size changes. The default size is 1040 bytes, but the size follows `MAX_LIGHTS`.

---

## Shader Logic

Light modules do not contain shaders. Lighting computation lives in material shader modules: Standard and NodeMaterial loop over `mesh.lc` / `mli(i)` into the group-0 lights UBO, and PBR dynamically imports either `singlelight-wgsl.ts` or `multilight-wgsl.ts` from `material/pbr/fragments/`.

---

## State Machine / Lifecycle

### Light Creation

```typescript
// Directional
const light = createDirectionalLight([0, -1, 0], 1.5);
light.position.set(10, 20, 10);  // triggers onDirty → markLocalDirty

// Point
const point = createPointLight([5, 3, 0], 2.0);
point.range = 100;

// Hemispheric
const hemi = createHemisphericLight([0, 1, 0], 0.7);
hemi.groundColor = [0.1, 0.1, 0.1];

// Spot
const spot = createSpotLight([0, 10, 0], [0, -1, 0], Math.PI / 3, 2.0, 1.5);
spot.angle = Math.PI / 4;
```

### Mutation & Dirty Tracking

- Setting `direction.x`, `direction.y`, `direction.z` or calling `direction.set(x,y,z)` on any `ObservableVec3` triggers `onDirty()` → `wm.markLocalDirty()` → increments `worldMatrixVersion`
- `worldMatrix` getter lazily recomputes from `getLocalMatrix()` and parent chain when dirty
- `_writeLightUbo` reads from `worldMatrix` (which auto-resolves parent transforms)

### Lights UBO Lifecycle

1. **Creation:** `ensureSceneLightState(engine, scene)` allocates a `getLightsUboSize()` UBO and stores it on `SceneContextInternal._lightGpuState`.
2. **Group-0 binding:** every `RenderTask` binds its task-owned scene UBO at binding 0 and the scene-owned lights UBO at binding 1.
3. **Per-frame refresh:** `refreshSceneLightsUBO(engine, scene)` compares the aggregate light version and light count, then writes the shared UBO only when needed.
4. **Light filtering:** only lights with `_writeLightUbo` defined are packed; up to `MAX_LIGHTS`.
5. **Resize for cap changes:** if `MAX_LIGHTS` changes and the UBO byte size changes, `ensureSceneLightState()` destroys/recreates the scene light buffer and render-pass tasks rebuild their group-0 bind group.
6. **Mesh selection:** material renderables write per-mesh `lc` and packed `li` indices into the mesh UBO; this selection respects `includedOnlyMeshIds` and `excludedMeshIds`.

**No GPU resources are created by light modules.** Light packing and scene-owned GPU state live in `lights-ubo.ts`; materials only own shaders, mesh/material UBOs, textures, and bind groups.

---

## Babylon.js Equivalence Map

| Babylon Lite                                    | Babylon.js                                  |
|-------------------------------------------------|---------------------------------------------|
| `createDirectionalLight(dir, intensity)`       | `new DirectionalLight(name, dir, scene)`    |
| `DirectionalLight.direction` (ObservableVec3)  | `DirectionalLight.direction` (Vector3)      |
| `DirectionalLight.position` (ObservableVec3)   | `DirectionalLight.position` (Vector3)       |
| `DirectionalLight.diffuse`                      | `DirectionalLight.diffuse`                  |
| `DirectionalLight.specular`                     | `DirectionalLight.specular`                 |
| `DirectionalLight.intensity`                    | `DirectionalLight.intensity`                |
| `createPointLight(pos, intensity)`             | `new PointLight(name, pos, scene)`          |
| `PointLight.range = Number.MAX_VALUE`           | `PointLight.range` (default very large)     |
| `createHemisphericLight(dir, intensity)`       | `new HemisphericLight(name, dir, scene)`    |
| `HemisphericLight.diffuseColor`                | `HemisphericLight.diffuse`                  |
| `HemisphericLight.specularColor`               | `HemisphericLight.specular`                 |
| `HemisphericLight.groundColor`                 | `HemisphericLight.groundColor`              |
| `createSpotLight(pos, dir, angle, exp, int)`   | `new SpotLight(name, pos, dir, angle, exp, scene)` |
| `SpotLight.angle`                              | `SpotLight.angle`                           |
| `SpotLight.exponent`                           | `SpotLight.exponent`                        |
| `SpotLight.range`                              | `SpotLight.range`                           |
| `LightBase.lightType` string discriminator     | Class hierarchy + `getTypeID()` (internal)  |
| `LightBase.excludedMeshIds`                    | `Light.excludedMeshes`                      |
| `LightBase.includedOnlyMeshIds`                | `Light.includedOnlyMeshes`                  |
| `LightBase.shadowGenerator`                    | `Light.getShadowGenerator()`                |
| `LightBase.parent` (IWorldMatrixProvider)      | `Light.parent` (TransformNode)              |
| Plain data objects (no scene ref)              | Class instances with scene reference         |
| `ObservableVec3` with dirty callback           | `Vector3` + `_markAsDirty()` pattern        |
| `localMatrixFromDirection()`                   | `Light._buildUniformLayout()` (internal)    |
| Light type w flag (0/1/2/3)                    | Internal type system (`LIGHTTYPEID_*`)      |
| `MAX_LIGHTS = 16` scene-wide cap              | `maxSimultaneousLights` (default 4 per material) |
| `fillLightsData()` / `writeLightsUBO()`       | Babylon's internal light UBO building       |
| `refreshLightsUBO()`                           | Per-frame light uniform update              |
| `singlelight-wgsl.ts` / `multilight-wgsl.ts`  | PBR shader includes (`pbrDirectLightingSetupFunctions`, etc.) |

### Key Differences from Babylon.js

1. **No scene reference** — Babylon Lite lights are POJOs with world-matrix accessors; Babylon.js lights are class instances that register with a Scene.
2. **`lightType` string discriminator** — Instead of class hierarchy, each light has a `lightType` string literal (`'directional'`, `'point'`, `'spot'`, `'hemispheric'`).
3. **`ObservableVec3`** — Direction/position use observable vectors with dirty callbacks, replacing Babylon's Vector3 + manual dirty tracking.
4. **Shared lights UBO** — Standard and PBR pack up to `MAX_LIGHTS` scene lights into one UBO; Babylon.js uses material-scoped light defines/uniforms and defaults to 4 simultaneous lights per material.
5. **Tree-shakable PBR light code** — PBR imports the one-light or multi-light WGSL helper only when needed; Babylon.js includes broad light shader support.
6. **No shadow caster list on lights or generators** — Shadow casters are scene/frame-graph `ShadowTask` inputs registered for a generator. Lights only reference their shadow generator via `shadowGenerator` property.

---

## Dependencies

### types.ts
- `../math/types.js` — `Mat4`
- `../scene/parentable.js` — `IWorldMatrixProvider`, `IParentable`
- `../shadow/shadow-generator.js` — `ShadowGenerator` (type-only import)

### light-base.ts
- `../math/types.js` — `Mat4`
- `../scene/parentable.js` — `IWorldMatrixProvider`
- `../scene/world-matrix-state.js` — `createWorldMatrixState`, `WorldMatrixAccessors`
- `../math/observable-vec3.js` — `ObservableVec3` (re-exported)

### light-matrix.ts
- `../math/types.js` — `Mat4`

### directional-light.ts
- `./types.js` — `LightBase`
- `./light-base.js` — `createLightBase`, `applyWorldMatrixAccessors`, `ObservableVec3`
- `./light-matrix.js` — `localMatrixFromDirection`

### point-light.ts
- `./types.js` — `LightBase`
- `../math/mat4.js` — `mat4Translation`
- `./light-base.js` — `createLightBase`, `applyWorldMatrixAccessors`, `ObservableVec3`

### hemispheric.ts
- `./types.js` — `LightBase`
- `./light-base.js` — `createLightBase`, `applyWorldMatrixAccessors`, `ObservableVec3`
- `./light-matrix.js` — `localMatrixFromDirection`

### spot-light.ts
- `./types.js` — `LightBase`
- `./light-base.js` — `createLightBase`, `applyWorldMatrixAccessors`, `ObservableVec3`
- `./light-matrix.js` — `localMatrixFromDirection`

### lights-ubo.ts
- `../light/types.js` — `LightBase`, `LightBaseInternal`, `MAX_LIGHTS`, `LIGHT_ENTRY_FLOATS`

---

## Test Specification

1. **Directional light defaults** — `createDirectionalLight([0, -1, 0])` returns `lightType: 'directional'`, direction `(0,-1,0)`, position `(0,0,0)`, diffuse `[1,1,1]`, specular `[1,1,1]`, intensity `1`.
2. **Point light defaults** — `createPointLight([5, 3, 0])` returns `lightType: 'point'`, position `(5,3,0)`, diffuse `[1,1,1]`, specular `[1,1,1]`, intensity `1`, range `Number.MAX_VALUE`.
3. **Hemispheric light defaults** — `createHemisphericLight()` returns `lightType: 'hemispheric'`, direction `(0,1,0)`, intensity `1`, diffuseColor `[1,1,1]`, specularColor `[1,1,1]`, groundColor `[0,0,0]`.
4. **Spot light defaults** — `createSpotLight([0,10,0], [0,-1,0], PI/3, 2)` returns `lightType: 'spot'`, diffuse `[1,1,1]`, specular `[1,1,1]`, intensity `1`, range `Number.MAX_VALUE`.
5. **Custom intensity** — `createDirectionalLight([1,0,0], 2.5).intensity` should be `2.5`.
6. **Mutability** — All properties should be directly assignable. ObservableVec3 properties support `.x`, `.y`, `.z` setters and `.set(x,y,z)`.
7. **Dirty tracking** — Setting `direction.x = 5` should increment `worldMatrixVersion`.
8. **World matrix** — Directional light's worldMatrix column 2 should match normalized direction.
9. **Parent support** — Setting `light.parent` should affect `worldMatrix` computation.
10. **Light type flags** — `_writeLightUbo` should set w=0 (point), w=1 (directional), w=2 (spot), w=3 (hemispheric).
11. **Spot UBO packing** — Spot light writes exponent at [11], direction at [12–14], cos(angle/2) at [15].
12. **Light UBO packing** — For directional light: `lightData.w = 1`, colors premultiplied by intensity.
13. **Light UBO packing** — For point light: `lightData.w = 0`, `lightDiffuse.a = range`.
14. **Lights UBO size** — `getLightsUboSize() = 272` bytes by default (16 header + 4 × 64).
15. **fillLightsData count** — With 6 lights, only first 4 with `_writeLightUbo` are packed.
16. **localMatrixFromDirection** — Verify column 2 = normalized direction, column 0 = right, column 1 = up.
17. **PBR single-light selection** — One non-shadow light imports `singlelight-wgsl.ts`, not the generic multi-light loop.
18. **PBR multi-light selection** — Multiple lights or shadow receivers import `multilight-wgsl.ts`.

---

## File Manifest

| File | Role |
|------|------|
| `src/light/types.ts` | `LightBase`, `LightBaseInternal` interfaces; `MAX_LIGHTS`, `setMaxLights()`, `LIGHT_ENTRY_FLOATS` |
| `src/light/light-base.ts` | `createLightBase()`, `applyWorldMatrixAccessors()` — shared world-matrix state factory; re-exports `ObservableVec3` |
| `src/light/light-matrix.ts` | `localMatrixFromDirection()` — builds local 4×4 matrix from direction + position |
| `src/light/directional-light.ts` | `DirectionalLight` interface + `createDirectionalLight()` factory |
| `src/light/point-light.ts` | `PointLight` interface + `createPointLight()` factory |
| `src/light/hemispheric.ts` | `HemisphericLight` interface + `createHemisphericLight()` factory |
| `src/light/spot-light.ts` | `SpotLight` interface + `createSpotLight()` factory |
| `src/render/lights-ubo.ts` | Shared lights UBO system — `getLightsUboSize()`, scene light GPU state, mesh light selection; packs up to `MAX_LIGHTS` scene lights |
