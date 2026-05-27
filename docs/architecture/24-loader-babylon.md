# Module: Loader Babylon
> Package path: `packages/babylon-lite/src/loader-babylon/`

## Purpose

Parses Babylon.js `.babylon` scene files and returns an `AssetContainer` with meshes, standard materials, point lights, and scene-level settings. The caller passes the result to `addToScene(scene, result)` which populates the `SceneContext`. Provides an alternative loading path to glTF for scenes authored in the Babylon.js editor or exported from 3ds Max / Unity.

## Public API Surface

### Functions

```typescript
export async function loadBabylon(
    engine: Engine,
    url: string,
    opts?: LoadBabylonOptions
): Promise<AssetContainer>;
```

### Types

```typescript
export interface LoadBabylonOptions {
    maxMeshes?: number;         // maximum meshes to load (default: all)
    loadTextures?: boolean;     // whether to load textures (default: true)
}

/** Returned by both loadGltf() and loadBabylon(). Passed to addToScene(). */
export type { AssetContainer } from "../asset-container.js";
```

### Usage

```typescript
const result = await loadBabylon(engine, "https://example.com/scene.babylon");
addToScene(scene, result);  // entities[], clearColor, animationGroups dispatched into scene
```

- `entities`: flat array of all loaded `Mesh` and `LightBase` objects
- `clearColor`: from `scene.clearColor` JSON field (if present), applied by `addToScene()`
- `animationGroups`: empty for `.babylon` (format has no animation groups)

## Internal Architecture

### .babylon JSON Schema (parsed types)

```typescript
interface BabylonScene {
    clearColor?: number[];
    ambientColor?: number[];
    cameras?: BabylonCamera[];
    lights?: BabylonLight[];
    materials?: BabylonMaterial[];
    multiMaterials?: BabylonMultiMaterial[];
    meshes?: BabylonMesh[];
    activeCameraID?: string;
}

interface BabylonCamera {
    name: string; id: string; type: string;
    position: number[]; rotation?: number[]; target?: number[];
    fov?: number; minZ?: number; maxZ?: number;
}

interface BabylonTexture {
    name: string;                    // filename relative to .babylon URL
    hasAlpha?: boolean;
    getAlphaFromRGB?: boolean;
    level?: number;
    coordinatesIndex?: number;       // 0 = UV1, 1 = UV2
    coordinatesMode?: number;        // 2 = spherical reflection
    uOffset?: number; vOffset?: number;
    uScale?: number; vScale?: number;
}

interface BabylonMaterial {
    name: string; id: string;
    diffuse?: number[]; specular?: number[]; specularPower?: number;
    emissive?: number[]; ambient?: number[]; alpha?: number; alphaCutOff?: number;
    diffuseTexture?: BabylonTexture | null;
    bumpTexture?: BabylonTexture | null;
    specularTexture?: BabylonTexture | null;
    ambientTexture?: BabylonTexture | null;
    lightmapTexture?: BabylonTexture | null;
    emissiveTexture?: BabylonTexture | null;
    opacityTexture?: BabylonTexture | null;
    reflectionTexture?: BabylonTexture | null;
    backFaceCulling?: boolean;
}

interface BabylonMultiMaterial {
    name: string; id: string;
    materials: string[];             // ordered sub-material IDs
}

interface BabylonSubMesh {
    materialIndex: number;
    verticesStart: number; verticesCount: number;
    indexStart: number; indexCount: number;
}

interface BabylonMesh {
    name: string; id: string;
    parentId?: string | null; materialId?: string | null;
    position?: number[]; rotation?: number[]; scaling?: number[];
    positions?: number[]; normals?: number[]; uvs?: number[]; uvs2?: number[];
    indices?: number[];
    subMeshes?: BabylonSubMesh[];
    isVisible?: boolean;
}

interface BabylonLight {
    name: string; id: string; type: number;     // 0=point, 1=directional, 2=spot, 3=hemispheric
    position?: number[]; direction?: number[];
    diffuse?: number[]; specular?: number[];
    intensity?: number; range?: number;
    excludedMeshesIds?: string[];
    includedOnlyMeshesIds?: string[];
}
```

### Loading Pipeline

```
fetch(url) → JSON parse → BabylonScene
     │
     ├── Scene settings: clearColor
     │
     ├── Materials: Build Map<id, StandardMaterialProps>
     │   └── For each material: create StandardMaterial, load textures in parallel
     │
     ├── MultiMaterials: Build Map<id, string[]> (sub-material ID arrays)
     │
     ├── Lights: Create point lights (type === 0) with position, intensity, colors, range
     │   └── Support: excludedMeshesIds, includedOnlyMeshesIds
     │
     └── Meshes: For each visible mesh with geometry:
         ├── Upload positions, normals, indices, uvs, uvs2 to GPU
         ├── Resolve material (direct or via multi-material subMesh)
         ├── Split into sub-meshes (each sub-mesh → separate GPU mesh)
         ├── Apply position/rotation/scaling transform
         └── Retain CPU geometry for picking (_cpuPositions, _cpuNormals, etc.)
```

### Material Resolution

1. Look up `mesh.materialId` in `multiMatMap`
2. If found: it's a multi-material → use sub-material IDs array
3. If not: treat `materialId` as single material ID
4. For each sub-mesh: `matIds[subMesh.materialIndex]` → lookup in `materialMap`
5. Fallback: `createStandardMaterial()` (default white material)

### Ambient Color Handling

BJS multiplies `material.ambient` by `scene.ambientColor`. The loader pre-multiplies:
```typescript
mat.ambientColor = [
    md.ambient[0] * sceneAmbient[0],
    md.ambient[1] * sceneAmbient[1],
    md.ambient[2] * sceneAmbient[2]
];
```

### Texture Loading

Textures are loaded in parallel via `Promise.all(texturePromises)`:
- URL resolution: `baseUrl + texture.name` where `baseUrl = url.substring(0, lastIndexOf("/") + 1)`
- Supported texture slots: diffuse, bump, specular, ambient, lightmap, emissive, opacity, reflection
- Per-texture properties mapped: `level` → material-specific level, `coordinatesIndex` → coord index, `uScale`/`vScale` → `uvScale`, `getAlphaFromRGB` → `opacityFromRGB`, `coordinatesMode === 2` → `reflectionCoordMode = 2` (spherical)
- Texture cache cleared on dispose via `clearTexture2DCache(device)`

### Sub-Mesh Handling

Each `BabylonSubMesh` becomes a separate GPU mesh with:
- Shared vertex buffers (positions, normals referenced from parent)
- Sliced index buffer: `allIndices.slice(sub.indexStart, sub.indexStart + sub.indexCount)`
- Individual material assignment from multi-material array
- Name: `meshName_sub{materialIndex}` for multi-sub-mesh meshes

### Differences from glTF Loading Path

| Aspect | glTF Loader | .babylon Loader |
|--------|------------|-----------------|
| Format | Binary GLB or JSON + .bin | Single JSON file |
| Material system | PBR (metallic-roughness) | Standard (Blinn-Phong) |
| Coordinate system | Right-handed → LH conversion | Already left-handed |
| Skeleton/animation | Full support | Not supported |
| Morph targets | Supported | Not supported |
| Multi-material | Not applicable (per-primitive) | SubMesh → multi-material mapping |
| Vertex data | Binary accessors + buffer views | Inline JSON number arrays |
| Texture references | URI or buffer-embedded | Filename relative to .babylon URL |
| Lights | Not in glTF core | Point lights with include/exclude |

## Pipeline Configuration

N/A — No GPU pipelines created by this module. Mesh upload uses `uploadMeshToGPU()` from mesh module.

## Shader Logic

N/A — Uses Standard material shaders (not managed by this loader).

## State Machine / Lifecycle

One-shot async loader. No persistent state. Registers `clearTexture2DCache` disposable on scene.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `SceneLoader.Load(".babylon")` | `addToScene(scene, await loadBabylon(engine, url))` |
| `StandardMaterial` | `createStandardMaterial()` → `StandardMaterialProps` |
| `MultiMaterial` | `multiMatMap: Map<id, string[]>` |
| `Mesh.subMeshes` | Split into individual GPU meshes per sub-mesh |
| `PointLight` | `createPointLight()` |
| `Light.excludedMeshes` | `pl.excludedMeshIds: Set<string>` |
| `Light.includedOnlyMeshes` | `pl.includedOnlyMeshIds: Set<string>` |

## Dependencies

- `../scene/scene.js` — `SceneContext`, `SceneContextInternal`
- `../engine/engine.js` — `EngineInternal` (device access)
- `../material/standard/standard-material.js` — `createStandardMaterial`, `StandardMaterialProps`
- `../mesh/mesh.js` — `uploadMeshToGPU`, `initMeshTransform`, `MeshInternal`
- `../light/point-light.js` — `createPointLight`
- `../texture/texture-2d.js` — `loadTexture2D`, `clearTexture2DCache`

## Test Specification

1. **Scene clear color**: Verify `scene.clearColor` set from JSON
2. **Material parsing**: Verify diffuse/specular/emissive colors, specularPower, alpha
3. **Texture loading**: Verify textures loaded with correct URLs and properties mapped
4. **Multi-material**: Verify sub-meshes assigned correct materials from multi-material array
5. **Mesh transform**: Verify position/rotation/scaling applied via `initMeshTransform`
6. **Point lights**: Verify position, intensity, diffuse/specular colors, range
7. **Light filtering**: Verify excludedMeshIds and includedOnlyMeshIds Sets created
8. **Invisible meshes**: Verify `isVisible: false` meshes are skipped
9. **maxMeshes**: Verify mesh count cap is respected
10. **CPU geometry retained**: Verify `_cpuPositions`, `_cpuNormals`, `_cpuIndices` set for picking

## File Manifest

| File | Purpose |
|---|---|
| `load-babylon.ts` | Complete .babylon format loader: JSON parsing, material/texture creation, mesh upload, light creation |
