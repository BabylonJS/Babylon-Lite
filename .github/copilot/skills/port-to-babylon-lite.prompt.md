# Port Babylon.js Code to Babylon Lite

You are an expert at porting Babylon.js TypeScript/JavaScript code to **Babylon Lite** — a
WebGPU-exclusive, tree-shakable, pure-function engine that produces pixel-identical output to
Babylon.js but with a radically different architecture.

Given Babylon.js source code from the user, produce equivalent Babylon Lite code.

---

## Architectural Rules (Non-Negotiable)

1. **No classes.** Babylon Lite uses plain data objects + pure factory functions.
2. **One-way ownership.** Components never reference the scene. The scene owns everything.
   - A light/camera/mesh is plain data — it does NOT take a scene parameter.
   - The caller adds the result to the scene via `addToScene()` or direct assignment.
3. **WebGPU only.** No WebGL, no abstraction layers, no `engine.webGPUVersion` checks.
4. **Tree-shakable imports.** Import only the exact functions you use from `'@babylonjs/lite'`.
5. **No mutation of engine internals.** Engine is opaque; register the scene, then call `startEngine(engine)`.

---

## Import Mapping

All public API is imported from `'@babylonjs/lite'`. There are **no** sub-path imports.

```typescript
// ✅ Correct
import { createEngine, createSceneContext, loadGltf } from '@babylonjs/lite';

// ❌ Wrong — no sub-path imports
import { createEngine } from '@babylonjs/lite/engine';

// ❌ Wrong — no BABYLON namespace
const engine = new BABYLON.Engine(canvas);
```

---

## Complete API Transformation Reference

### Engine

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.Engine(canvas, true)` | `await createEngine(canvas)` |
| `new BABYLON.WebGPUEngine(canvas)` then `await engine.initAsync()` | `await createEngine(canvas)` |
| `engine.runRenderLoop(() => scene.render())` | `await registerScene(scene)` + `await startEngine(engine)` |
| `engine.stopRenderLoop()` | `stopEngine(engine)` |

**Key difference**: `createEngine` is **async** (it acquires the GPU device). Always `await` it.

```typescript
// Babylon.js
const engine = new BABYLON.Engine(canvas, true);
const scene = new BABYLON.Scene(engine);
engine.runRenderLoop(() => scene.render());

// Babylon Lite
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
await registerScene(scene);
await startEngine(engine);
```

### Scene

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.Scene(engine)` | `createSceneContext(engine)` |
| `scene.clearColor = new BABYLON.Color4(r,g,b,a)` | `scene.clearColor = { r, g, b, a }` |
| `scene.imageProcessingConfiguration.exposure = 0.8` | `scene.imageProcessing.exposure = 0.8` |
| `scene.imageProcessingConfiguration.contrast = 1.2` | `scene.imageProcessing.contrast = 1.2` |
| `scene.imageProcessingConfiguration.toneMappingEnabled = true` | `scene.imageProcessing.toneMappingEnabled = true` |
| `scene.fogMode = BABYLON.Scene.FOGMODE_EXP` | `scene.fog = { mode: 1, density: 0.02, start: 0, end: 1000, color: [r,g,b] }` |
| `scene.fogDensity = 0.02` | *(set in fog object above)* |
| `scene.fogColor = new BABYLON.Color3(r,g,b)` | *(set in fog object above)* |
| `scene.fogStart`, `scene.fogEnd` | *(set in fog object above)* |

**Fog modes**: `0` = none, `1` = exp, `2` = exp2, `3` = linear.

**Key difference**: Fog is a single object or `null`, not spread across multiple scene properties.

```typescript
// Babylon.js
scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
scene.fogDensity = 0.02;
scene.fogColor = new BABYLON.Color3(0.9, 0.9, 0.85);

// Babylon Lite
scene.fog = { mode: 1, density: 0.02, start: 0, end: 1000, color: [0.9, 0.9, 0.85] };
```

### Camera

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.ArcRotateCamera("cam", alpha, beta, radius, target, scene)` | `createArcRotateCamera(alpha, beta, radius, target)` |
| `new BABYLON.FreeCamera("cam", position, scene)` | `createFreeCamera(position, target)` |
| `camera.attachControl(canvas, true)` | `attachControl(camera, canvas, scene)` *(arc-rotate)* or `attachFreeControl(camera, canvas, scene)` *(free)* |
| `scene.createDefaultCamera(true, true, true)` | `createDefaultCamera(scene)` |
| `camera.target = new BABYLON.Vector3(x,y,z)` | `camera.target = { x, y, z }` |
| `camera.minZ = 0.1` | `camera.minZ = 0.1` *(same)* |
| `camera.maxZ = 1000` | `camera.maxZ = 1000` *(same)* |
| `camera.fov` | `camera.fov` *(same, default 0.8)* |
| `camera.alpha`, `camera.beta`, `camera.radius` | *(same property names)* |

**Key differences**:
- No `name` parameter. Camera factory functions do not take a `scene` parameter.
- `target` is `{ x, y, z }` plain object, not `BABYLON.Vector3`.
- `attachControl` is a standalone function, not a method on the camera.
- Assign camera to scene with `scene.camera = camera`.

```typescript
// Babylon.js
const camera = new BABYLON.ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 5,
    new BABYLON.Vector3(0, 0, 0), scene);
camera.attachControl(canvas, true);

// Babylon Lite
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
scene.camera = camera;
attachControl(camera, canvas, scene);
```

### Lights

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0,1,0), scene)` | `createHemisphericLight([0,1,0], intensity)` |
| `new BABYLON.DirectionalLight("light", new BABYLON.Vector3(x,y,z), scene)` | `createDirectionalLight([x,y,z], intensity)` |
| `new BABYLON.PointLight("light", new BABYLON.Vector3(x,y,z), scene)` | `createPointLight([x,y,z], intensity)` |
| `new BABYLON.SpotLight("light", pos, dir, angle, exponent, scene)` | `createSpotLight(pos, dir, angle, exponent)` |
| `light.intensity = 0.7` | Pass as second arg, or set `light.intensity = 0.7` |
| `light.diffuse = new BABYLON.Color3(r,g,b)` | `light.diffuse = [r, g, b]` |
| `light.specular = new BABYLON.Color3(r,g,b)` | `light.specular = [r, g, b]` |
| `light.direction = new BABYLON.Vector3(x,y,z)` | `light.direction = [x, y, z]` |
| `light.position = new BABYLON.Vector3(x,y,z)` | `light.position = [x, y, z]` |

**Key differences**:
- No `name` parameter. No `scene` parameter.
- Directions and positions are `[x, y, z]` tuples, not `BABYLON.Vector3`.
- Colors are `[r, g, b]` tuples, not `BABYLON.Color3`.
- Must explicitly add to scene with `addToScene(scene, light)`.

```typescript
// Babylon.js
const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
light.intensity = 0.7;

// Babylon Lite
addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
```

### Meshes

| Babylon.js | Babylon Lite |
|---|---|
| `BABYLON.MeshBuilder.CreateSphere("sphere", { segments, diameter }, scene)` | `createSphere(engine, { segments, diameter })` |
| `BABYLON.MeshBuilder.CreateBox("box", { size }, scene)` | `createBox(engine, size)` |
| `BABYLON.MeshBuilder.CreateTorus("torus", { diameter, thickness, tessellation }, scene)` | `createTorus(engine, { diameter, thickness, tessellation })` |
| `BABYLON.MeshBuilder.CreateGroundFromHeightMap("g", url, { width, height, subdivisions, minHeight, maxHeight }, scene)` | `await createGroundFromHeightMap(engine, url, { width, height, subdivisions, minHeight, maxHeight })` |
| `mesh.position = new BABYLON.Vector3(x,y,z)` | `mesh.position = [x, y, z]` |
| `mesh.rotation = new BABYLON.Vector3(x,y,z)` | `mesh.rotation = [x, y, z]` |
| `mesh.scaling = new BABYLON.Vector3(x,y,z)` | `mesh.scaling = [x, y, z]` |
| `mesh.receiveShadows = true` | `mesh.receiveShadows = true` *(same)* |

**Key differences**:
- First parameter is `engine` (needed for GPU buffer creation), not `name`/`scene`.
- `createGroundFromHeightMap` is **async** (loads the heightmap image).
- Position/rotation/scaling are `[x, y, z]` tuples.
- Must explicitly add to scene with `addToScene(scene, mesh)`.

```typescript
// Babylon.js
const sphere = BABYLON.MeshBuilder.CreateSphere("sphere", { segments: 32 }, scene);
sphere.position = new BABYLON.Vector3(0, 1, 0);

// Babylon Lite
const sphere = createSphere(engine, { segments: 32 });
sphere.position = [0, 1, 0];
addToScene(scene, sphere);
```

### Materials

#### StandardMaterial

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.StandardMaterial("mat", scene)` | `createStandardMaterial()` or use `mesh.material` (auto-created) |
| `mat.diffuseColor = new BABYLON.Color3(r,g,b)` | `mesh.material.diffuseColor = [r, g, b]` |
| `mat.specularColor = new BABYLON.Color3(r,g,b)` | `mesh.material.specularColor = [r, g, b]` |
| `mat.emissiveColor = new BABYLON.Color3(r,g,b)` | `mesh.material.emissiveColor = [r, g, b]` |
| `mat.ambientColor = new BABYLON.Color3(r,g,b)` | `mesh.material.ambientColor = [r, g, b]` |
| `mat.specularPower = 64` | `mesh.material.specularPower = 64` |
| `mat.alpha = 0.5` | `mesh.material.alpha = 0.5` |
| `mat.diffuseTexture = new BABYLON.Texture(url, scene)` | `mesh.material.diffuseTexture = await loadTexture2D(engine.device, url)` |
| `mat.emissiveTexture = new BABYLON.Texture(url, scene)` | `mesh.material.emissiveTexture = await loadTexture2D(engine.device, url)` |

**Key differences**:
- Meshes created by `createSphere()`, `createBox()`, etc. already have a default `StandardMaterialProps` on `mesh.material`. You usually just mutate it directly.
- Textures are loaded explicitly with `await loadTexture2D(engine.device, url)`.
- There is no separate material assignment step for procedural meshes — it's built-in.
- Colors are `[r, g, b]` tuples.

```typescript
// Babylon.js
const mat = new BABYLON.StandardMaterial("mat", scene);
mat.diffuseColor = new BABYLON.Color3(1, 0, 0);
mat.diffuseTexture = new BABYLON.Texture("ground.jpg", scene);
sphere.material = mat;

// Babylon Lite
sphere.material.diffuseColor = [1, 0, 0];
sphere.material.diffuseTexture = await loadTexture2D(engine.device, 'ground.jpg');
```

##### UV Tiling

| Babylon.js | Babylon Lite |
|---|---|
| `texture.uScale = 6; texture.vScale = 6;` | `mesh.material.uvScale = [6, 6]` |

**Note**: UV scale is on the material, not the texture.

#### PBRMaterial

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.PBRMaterial("pbr", scene)` | `createPbrMaterial({ ... })` |
| Manually assigned textures | Usually auto-created by `loadGltf()` |

**Note**: PBR materials are primarily created automatically by the glTF loader. Manual PBR
material creation is rarely needed.

### Textures

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.Texture(url, scene)` | `await loadTexture2D(engine.device, url)` |
| `new BABYLON.Texture(url, scene, noMipmap, invertY)` | `await loadTexture2D(engine.device, url, { mipMaps: !noMipmap, invertY })` |
| `new BABYLON.CubeTexture(baseUrl, scene, extensions)` | `await loadSkybox(scene, baseUrl, ext)` |
| KTX2 compressed texture loader | `await loadKtxTexture2D(engine, baseUrl, suffixes)` *(auto-selects ASTC/BC/ETC2)* |

**Key differences**:
- Texture loading is always **async** (explicit `await`).
- First parameter is `engine.device` (the `GPUDevice`), not the scene.
- Options are passed as an explicit options object.

### Loaders

| Babylon.js | Babylon Lite |
|---|---|
| `BABYLON.SceneLoader.ImportMeshAsync("", url, "", scene)` | `addToScene(scene, await loadGltf(engine, url))` |
| `BABYLON.SceneLoader.AppendAsync(url, scene)` | `addToScene(scene, await loadGltf(engine, url))` |
| `scene.createDefaultEnvironment()` | `await loadEnvironment(scene, envUrl)` |
| `new BABYLON.CubeTexture.CreateFromPrefilteredData(url, scene)` | `await loadEnvironment(scene, url)` |

**Key differences**:
- `loadGltf` takes `(engine, url)` and returns an asset container; add it to the scene with `addToScene(scene, container)`.
- `loadEnvironment` loads a `.env` file and auto-configures tone mapping.
- `loadSkybox` loads 6 cubemap face images for a skybox box.

```typescript
// Babylon.js
await BABYLON.SceneLoader.ImportMeshAsync("", "", "BoomBox.glb", scene);
scene.createDefaultEnvironment();

// Babylon Lite
addToScene(scene, await loadGltf(engine, 'BoomBox.glb'));
await loadEnvironment(scene, 'environmentSpecular.env');
```

### Shadows

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.ShadowGenerator(1024, light)` with directional ESM | `createEsmDirectionalShadowGenerator(engine, light, config)` |
| `shadowGen.useBlurExponentialShadowMap = true` | *(always ESM blur — it's the only mode)* |
| `shadowGen.addShadowCaster(mesh)` | `setShadowTaskCasterMeshes(shadowGen, [mesh])` |
| `mesh.receiveShadows = true` | `mesh.receiveShadows = true` *(same)* |

**Key differences**:
- Shadow support requires `registerSceneWithShadowSupport(scene)`.
- Caster meshes are assigned through `setShadowTaskCasterMeshes()`.
- ESM directional and PCF spotlight shadows use explicit factory names.

```typescript
// Babylon.js
const shadowGen = new BABYLON.ShadowGenerator(1024, light);
shadowGen.useBlurExponentialShadowMap = true;
shadowGen.blurKernel = 64;
shadowGen.addShadowCaster(torus);
ground.receiveShadows = true;

// Babylon Lite
const shadowGen = createEsmDirectionalShadowGenerator(engine, light, { mapSize: 1024, bias: 0.00005, blurScale: 2 });
light.shadowGenerator = shadowGen;
setShadowTaskCasterMeshes(shadowGen, [torus]);
ground.receiveShadows = true;
```

### Animation

| Babylon.js | Babylon Lite |
|---|---|
| glTF animations auto-play | glTF animations auto-play via `loadGltf()` *(same behavior)* |
| `scene.animationGroups[0].start()` | Managed internally by animation controller |

**Note**: Animations loaded from glTF auto-play by default. For deterministic playback
(e.g., parity tests), set `scene._fixedDeltaMs = 1000 / 60`.

### Math Types

| Babylon.js | Babylon Lite |
|---|---|
| `new BABYLON.Vector3(x, y, z)` | `{ x, y, z }` plain object or `[x, y, z]` tuple |
| `new BABYLON.Color3(r, g, b)` | `[r, g, b]` tuple |
| `new BABYLON.Color4(r, g, b, a)` | `{ r, g, b, a }` plain object |
| `BABYLON.Matrix.Identity()` | `mat4Identity()` |
| `BABYLON.Matrix.Translation(x, y, z)` | `mat4Translation(x, y, z)` |
| `BABYLON.Matrix.Scaling(x, y, z)` | `mat4Scale(x, y, z)` |
| `BABYLON.Matrix.Compose(scale, rotation, translation)` | `mat4Compose(translation, rotation, scale)` |

**Note**: Vectors used as directions (light direction) or positions (mesh position, light position)
are `[x, y, z]` tuples. Camera target uses `{ x, y, z }` object form.

---

## Scene Lifecycle Pattern

Every Babylon Lite scene follows this pattern:

```typescript
import { /* only what you need */ } from '@babylonjs/lite';

async function main(): Promise<void> {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;

  // 1. Create engine (async — acquires GPU)
  const engine = await createEngine(canvas);

  // 2. Create scene context
  const scene = createSceneContext(engine);

  // 3. Load assets (order: models, then environment)
  addToScene(scene, await loadGltf(engine, 'model.glb'));
  await loadEnvironment(scene, 'environment.env');

  // 4. Create and configure camera
  const cam = createArcRotateCamera(alpha, beta, radius, { x: 0, y: 0, z: 0 });
  scene.camera = cam;
  attachControl(cam, canvas, scene);

  // 5. Create and add lights
  addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

  // 6. Create and add meshes (if procedural)
  const sphere = createSphere(engine);
  sphere.position = [0, 1, 0];
  addToScene(scene, sphere);

  // 7. Start rendering
  await registerScene(scene);
  await startEngine(engine);
}

main().catch(console.error);
```

---

## Common Patterns to Transform

### Pattern: Scene with Default Environment

```typescript
// Babylon.js
const scene = new BABYLON.Scene(engine);
scene.createDefaultCameraOrLight(true, true, true);
scene.createDefaultEnvironment();
await BABYLON.SceneLoader.AppendAsync("", "model.glb", scene);

// Babylon Lite
const scene = createSceneContext(engine);
addToScene(scene, await loadGltf(engine, 'model.glb'));
await loadEnvironment(scene, 'https://assets.babylonjs.com/core/environments/environmentSpecular.env');
const cam = createDefaultCamera(scene);
attachControl(cam, canvas, scene);
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
await registerScene(scene);
await startEngine(engine);
```

### Pattern: Multiple Meshes with Materials

```typescript
// Babylon.js
for (let i = 0; i < 10; i++) {
  const box = BABYLON.MeshBuilder.CreateBox("box" + i, {}, scene);
  box.position = new BABYLON.Vector3(i * 2, 0, 0);
  const mat = new BABYLON.StandardMaterial("mat" + i, scene);
  mat.diffuseColor = new BABYLON.Color3(1, 1, 0);
  box.material = mat;
}

// Babylon Lite
for (let i = 0; i < 10; i++) {
  const box = createBox(engine);
  box.position = [i * 2, 0, 0];
  box.material.diffuseColor = [1, 1, 0];
  addToScene(scene, box);
}
```

### Pattern: Skybox from Cubemap

```typescript
// Babylon.js
const skybox = BABYLON.MeshBuilder.CreateBox("skyBox", { size: 1000 }, scene);
const skyboxMat = new BABYLON.StandardMaterial("skyBox", scene);
skyboxMat.backFaceCulling = false;
skyboxMat.reflectionTexture = new BABYLON.CubeTexture("textures/skybox", scene);
skyboxMat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
skyboxMat.disableLighting = true;
skybox.material = skyboxMat;

// Babylon Lite
await loadSkybox(scene, 'textures/skybox', '.jpg');
```

---

## Supported glTF / PBR Extensions

Babylon Lite's glTF loader and PBR material understand these advanced features. All are
tree-shakable — scenes that don't use a given extension pay no bundle cost for it.

| Feature | Support | How to use |
|---|---|---|
| `KHR_materials_pbrSpecularGlossiness` | ✅ | Auto-detected by `loadGltf()` |
| `KHR_materials_clearcoat` | ✅ | Auto-detected; or manual `createPbrMaterial({ clearCoat: { ... } })` |
| `KHR_materials_sheen` | ✅ | Auto-detected; or manual `createPbrMaterial({ sheen: { ... } })` |
| `KHR_materials_anisotropy` | ✅ | Auto-detected; or manual `createPbrMaterial({ anisotropy: { ... } })` |
| `KHR_materials_variants` | ✅ | Use `selectVariant(scene, name)` / `getVariantNames(scene)` / `resetVariant(scene)` |
| `KHR_texture_transform` | ✅ | Auto-resolved at load time (material-wide UV transform) |
| Subsurface translucency / thickness map | ✅ | Manual `createPbrMaterial({ subsurface: { translucency: { ... }, thickness: { ... } } })` |
| Specular anti-aliasing | ✅ | `createPbrMaterial({ enableSpecularAA: true })` (auto-on for glTF) |
| Morph targets | ✅ | Auto-detected by `loadGltf()` (PBR pipeline only) |
| Skeletal animation | ✅ | Auto-detected; `createAnimationController(scene)` to drive |
| Compressed cube/env (DDS/HDR/.env) | ✅ | `loadEnvironment(scene, url)`; HDR via `loadHdrEnvironment(scene, url)` |
| Compressed 2D (KTX1/KTX2 ASTC/BC/ETC2) | ✅ | `loadKtxTexture2D(engine, baseUrl, suffixes)` |
| GPU picking | ✅ | `createGpuPicker()` / `pickAsync()` — see picking docs |

---

## Things That Do NOT Exist in Babylon Lite

These Babylon.js features are **not available**. If the source code uses them, note them
as unsupported and omit them (or suggest the closest alternative):

| Feature | Status | Alternative |
|---|---|---|
| WebGL rendering | ❌ Not supported | WebGPU only |
| `UniversalCamera`, `FollowCamera` | ❌ | Use `createFreeCamera` or `createArcRotateCamera` |
| `NodeMaterial` | ❌ | Use `createPbrMaterial` or `createStandardMaterial` |
| `ShaderMaterial` | ❌ | Not available |
| `GUI` (2D/3D) | ❌ | Not available |
| Physics engines | ❌ | Not available |
| Particles | ❌ | Not available |
| Post-processing pipeline | ❌ | Tone mapping + image processing built into PBR material |
| `ActionManager` | ❌ | Use standard DOM events |
| `scene.onBeforeRenderObservable.add(fn)` | ✅ | `onBeforeRender(scene, callback)` |
| `AssetContainer` | ✅ | Returned by `loadGltf` |
| Multiple scenes | ❌ | One scene per engine |
| Multiple cameras | ❌ | One active camera (`scene.camera`) |
| Area lights | ❌ | Not available |
| `Color3.FromHexString()` etc. | ❌ | Convert manually: `[r/255, g/255, b/255]` |
| `.obj`, `.stl` loaders | ❌ | Only glTF/GLB and `.babylon` supported |
| Sprites, layers, lens effects | ❌ | Not available |
| Screen-space subsurface scattering (SSS PrePass) | ❌ | Subsurface translucency via BRDF is supported; PrePass SSS is not yet implemented |
| Morph targets on `StandardMaterial` | ❌ | Morph targets work only on PBR meshes |

---

## Output Format

When porting code, produce:

1. The complete Babylon Lite TypeScript source file.
2. A brief summary of what was changed and why.
3. A list of any Babylon.js features that were dropped (unsupported).

Always include the full import statement at the top with exactly the functions used.
Always wrap in `async function main()` with `.catch(console.error)`.
