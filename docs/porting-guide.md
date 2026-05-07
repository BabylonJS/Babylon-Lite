# Porting from Babylon.js to Babylon Lite

This guide shows how to translate a Babylon.js (BJS) scene to Babylon Lite, side by side. Babylon Lite uses **factory functions** instead of constructors, **plain data** instead of class instances, and explicit `addToScene()` instead of auto-registration.

---

## Quick Reference

| Babylon.js | Babylon Lite |
|---|---|
| `new WebGPUEngine(canvas); await engine.initAsync()` | `const engine = await createEngine(canvas)` |
| `new Scene(engine)` | `createSceneContext(engine)` |
| `engine.runRenderLoop(() => scene.render())` | `await startEngine(engine, scene)` |
| `new ArcRotateCamera("cam", α, β, r, target, scene)` | `createArcRotateCamera(α, β, r, target)` |
| `new FreeCamera("cam", position, scene)` | `createFreeCamera(position, target)` |
| `scene.createDefaultCamera(true, true, true)` | `createDefaultCamera(scene)` |
| `camera.attachControl(canvas, true)` | `attachControl(camera, canvas, scene)` *(arc-rotate)* / `attachFreeControl(camera, canvas)` *(free)* |
| `new HemisphericLight("h", new Vector3(0,1,0), scene)` | `createHemisphericLight([0,1,0], 1.0)` |
| `new DirectionalLight("d", new Vector3(0,-1,0), scene)` | `createDirectionalLight([0,-1,0])` |
| `new SpotLight("s", pos, dir, angle, exp, scene)` | `createSpotLight(pos, dir, angle, exp)` |
| `MeshBuilder.CreateSphere("s", {}, scene)` | `createSphere(engine)` |
| `MeshBuilder.CreateBox("b", {}, scene)` | `createBox(engine)` |
| `MeshBuilder.CreateGround("g", {}, scene)` | `createGround(engine, opts)` |
| `new StandardMaterial("mat", scene)` | `createStandardMaterial()` |
| `new PBRMaterial("pbr", scene)` | `createPbrMaterial()` |
| `SceneLoader.ImportMeshAsync("", url, file, scene)` | `addToScene(scene, await loadGltf(engine, url))` |
| `new CubeTexture(url, scene)` + `createDefaultEnvironment()` | `await loadEnvironment(scene, url, opts)` |
| `new Texture(url, scene)` | `await loadTexture2D(engine, url)` |
| KTX1 compressed 2D texture | `await loadKtxTexture2D(engine, baseUrl, suffixes)` |
| glTF KTX2 / `KHR_texture_basisu` texture source | `addToScene(scene, await loadGltf(engine, ktx2GltfUrl))` *(auto-detected)* |
| Basis Universal (.basis) 2D texture | `await loadBasisTexture2D(engine, url)` |
| `new ShadowGenerator(size, light)` | `createShadowGenerator(engine, light, casters, opts)` |
| `sg.usePercentageCloserFiltering = true` | `createPcfShadowGenerator(engine, light, casters, opts)` |
| `mesh.thinInstanceSetBuffer("matrix", data, 16)` | `setThinInstances(mesh, data, count)` |
| `mesh.thinInstanceSetBuffer("color", data, 4)` | `setThinInstanceColors(mesh, data)` |
| `new Vector3(x, y, z)` | `{ x, y, z }` or `[x, y, z]` |
| `new Color3(r, g, b)` | `[r, g, b]` |
| `Matrix.Identity()` | `mat4Identity()` |
| `mesh.dispose()` | `removeFromScene(scene, mesh)` |
| `scene.onBeforeRenderObservable.add(fn)` | `onBeforeRender(scene, fn)` |

---

## Key Differences

### 1. No Scene in Constructors

BJS objects take `scene` in their constructor and auto-register. Lite objects are plain data — you create them, then `addToScene()` them explicitly.

```typescript
// ❌ Babylon.js
const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);

// ✅ Babylon Lite
const light = createHemisphericLight([0, 1, 0], 1.0);
addToScene(scene, light);
```

### 2. Engine & Render Loop

BJS uses `runRenderLoop` with a callback. Lite uses a single `startEngine(engine, scene)` that returns a promise resolving after the first frame.

```typescript
// ❌ Babylon.js
const engine = new WebGPUEngine(canvas);
await engine.initAsync();
const scene = new Scene(engine);
// ... setup ...
engine.runRenderLoop(() => scene.render());

// ✅ Babylon Lite
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
// ... setup ...
await startEngine(engine, scene);
```

### 3. Plain Data, Not Classes

Lite uses plain objects, arrays, and `Float32Array` instead of BJS classes like `Vector3`, `Color3`, `Matrix`.

```typescript
// ❌ Babylon.js
light.direction = new Vector3(0, -1, 0);
light.diffuse = new Color3(1, 0, 0);

// ✅ Babylon Lite
const light = createDirectionalLight([0, -1, 0]);
light.diffuse = [1, 0, 0];
```

### 4. Camera Controls Are Separate

BJS cameras have `attachControl` as a method. Lite separates camera data from input handling.

```typescript
// ❌ Babylon.js
const camera = new ArcRotateCamera("cam", -Math.PI/2, Math.PI/2, 5, Vector3.Zero(), scene);
camera.attachControl(canvas, true);

// ✅ Babylon Lite
const camera = createArcRotateCamera(-Math.PI/2, Math.PI/2, 5, { x: 0, y: 0, z: 0 });
scene.camera = camera;
attachControl(camera, canvas, scene);
```

### 5. Loaders and Scene Registration

`loadEnvironment()` adds its environment data/renderables to the scene internally. `loadGltf()` returns an asset container; pass it to `addToScene()` so transform-node hierarchies, meshes, and animation groups are registered explicitly.

```typescript
// ❌ Babylon.js
await SceneLoader.ImportMeshAsync("", baseUrl, "model.glb", scene);
scene.environmentTexture = new CubeTexture(envUrl, scene);
scene.createDefaultEnvironment({ createSkybox: true, skyboxSize: 1000 });

// ✅ Babylon Lite
addToScene(scene, await loadGltf(engine, "model.glb"));
await loadEnvironment(scene, envUrl, {
    skyboxUrl: "skybox.dds",
    skyboxSize: 1000,
    groundTextureUrl: "ground.png",
    brdfUrl: "/brdf-lut.png",
});
```

### 6. Shadows Attach to Lights

BJS creates a `ShadowGenerator` separately. Lite assigns it directly to the light.

```typescript
// ❌ Babylon.js
const sg = new ShadowGenerator(1024, light);
sg.addShadowCaster(mesh);
sg.useBlurExponentialShadowMap = true;
ground.receiveShadows = true;

// ✅ Babylon Lite
light.shadowGenerator = createShadowGenerator(engine, light, [mesh], {
    mapSize: 1024,
    depthScale: 50,
    blurScale: 2,
});
ground.receiveShadows = true;
```

For PCF shadows:
```typescript
// ❌ Babylon.js
const sg = new ShadowGenerator(1024, spotLight);
sg.usePercentageCloserFiltering = true;

// ✅ Babylon Lite
spotLight.shadowGenerator = createPcfShadowGenerator(engine, spotLight, [mesh], {
    mapSize: 1024,
});
```

### 7. Thin Instances Use Raw Arrays

No `Matrix` class needed. Pass raw `Float32Array` with 16 floats per instance.

```typescript
// ❌ Babylon.js
const matrices = new Float32Array(count * 16);
// ... fill with Matrix values ...
mesh.thinInstanceSetBuffer("matrix", matrices, 16);
mesh.thinInstanceSetBuffer("color", colors, 4);

// ✅ Babylon Lite
const matrices = new Float32Array(count * 16);
// ... fill directly (column-major 4x4) ...
setThinInstances(mesh, matrices, count);
setThinInstanceColors(mesh, colors);
addToScene(scene, mesh);
```

### 8. Mesh Factories Take Engine, Not Scene

BJS mesh builders take `scene`. Lite mesh factories take `engine` (for GPU buffer creation) and return plain mesh data.

```typescript
// ❌ Babylon.js
const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2 }, scene);
sphere.material = new StandardMaterial("mat", scene);

// ✅ Babylon Lite
const sphere = createSphere(engine);
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
```

### 9. Removing & Disposing Entities

BJS uses `mesh.dispose()` on individual objects. Lite uses `removeFromScene()` which removes the mesh from the scene and destroys all its GPU resources (buffers, textures, skeleton data).

```typescript
// ❌ Babylon.js
sphere.dispose();

// ✅ Babylon Lite
removeFromScene(scene, sphere);
```

For full teardown:
```typescript
// ✅ Babylon Lite — tear down everything
disposeScene(scene);   // releases all meshes, renderables, disposables
disposeEngine(engine);  // destroys GPU device, render targets, swapchain
```

---

## Full Example: Porting a PBR Scene

### Babylon.js
```typescript
const engine = new WebGPUEngine(canvas);
await engine.initAsync();
const scene = new Scene(engine);
scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

const light = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
light.intensity = 1.0;

await SceneLoader.ImportMeshAsync("", baseUrl, "BoomBox.glb", scene);
const envTex = new CubeTexture(envUrl, scene);
scene.environmentTexture = envTex;
scene.createDefaultCamera(true, true, true);
scene.createDefaultEnvironment({ skyboxSize: 1000 });

engine.runRenderLoop(() => scene.render());
```

### Babylon Lite
```typescript
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, await loadGltf(engine, "BoomBox.glb"));
await loadEnvironment(scene, envUrl, {
    skyboxUrl: "skybox.dds",
    skyboxSize: 1000,
    groundTextureUrl: "ground.png",
    brdfUrl: "/brdf-lut.png",
});

const cam = createDefaultCamera(scene);
attachControl(cam, canvas, scene);
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

await startEngine(engine, scene);
```

---

## Gotchas

| Gotcha | Details |
|---|---|
| **No auto-add** | Meshes, lights, transform nodes, and `loadGltf()` asset containers must be explicitly added with `addToScene()`. `loadEnvironment()` adds its environment data/renderables internally. |
| **No `new` keyword** | Everything is created via factory functions, not constructors. |
| **Assign camera explicitly** | Either use `createDefaultCamera(scene)` (auto-assigns) or set `scene.camera = myCamera` manually. |
| **Materials are optional** | `createStandardMaterial()` / `createPbrMaterial()` return props objects. Assign to `mesh.material`. |
| **WebGPU only** | No WebGL fallback. `createEngine()` throws if WebGPU is unavailable. |
| **No `dispose()` on meshes** | Use `removeFromScene(scene, mesh)` to remove a single mesh and destroy its GPU resources. Use `disposeScene(scene)` + `disposeEngine(engine)` to tear down everything. |
| **Tree-shakable imports** | Import only what you use. Unused features are stripped from the bundle. |
| **KTX2 is glTF-scoped** | KTX1 has a direct `loadKtxTexture2D()` helper. KTX2/BasisU texture sources are handled through glTF `KHR_texture_basisu` during `loadGltf()` so non-KTX2 scenes pay zero runtime bundle cost. |
| **Material property animation** | Mutating material props at runtime requires marking the material dirty. See Material Animation section below. |

---

## Material Animation

Babylon Lite supports animating material properties at runtime (e.g. changing colors, alpha, anisotropy intensity per frame). Two approaches are available:

### Manual (default — zero overhead)

Mutate the property, then call `markMaterialDirty()`:

```typescript
import { markMaterialDirty } from "babylon-lite";

onBeforeRender(scene, () => {
    material.alpha = Math.sin(time) * 0.5 + 0.5;
    markMaterialDirty(material);
});
```

This works for both PBR and Standard materials. Zero runtime cost when nothing changes.

### Automatic tracking (opt-in)

Call `enableMaterialTracking()` once on a material to install property setters that auto-detect changes — including in-place array mutations like `material.diffuseColor[0] = 0.5`:

```typescript
import { enableMaterialTracking } from "babylon-lite";

const mat = createPbrMaterial({ anisotropy: { isEnabled: true, intensity: 1.0 } });
enableMaterialTracking(mat);

// Now mutations auto-set the dirty flag — no markMaterialDirty() needed:
onBeforeRender(scene, () => {
    mat.anisotropy!.intensity = Math.cos(a) * 0.5 + 0.5;  // auto-dirty
    mat.emissiveColor![0] = 0.5;                            // auto-dirty (index write)
});
```

`enableMaterialTracking` is fully tree-shakable — scenes that don't import it pay zero bundle cost.

| Feature | `markMaterialDirty` | `enableMaterialTracking` |
|---|---|---|
| Bundle cost | ~50 bytes | ~1.5 KB (only if imported) |
| Per-frame cost | Zero (manual call) | Zero (setter fires only on change) |
| Catches `color[0] = x` | ❌ (must call manually) | ✅ |
| Catches `mat.alpha = x` | ❌ (must call manually) | ✅ |

---

## glTF / PBR Extensions

Babylon Lite's glTF loader + PBR material understand the following extensions. Each
feature is tree-shakable: scenes that don't use it pay no bundle cost.

| Extension / Feature | Support | Notes |
|---|---|---|
| `KHR_materials_pbrSpecularGlossiness` | ✅ | Auto-detected by `loadGltf()` |
| `KHR_materials_clearcoat` | ✅ | Auto-detected; or `createPbrMaterial({ clearCoat: { ... } })` |
| `KHR_materials_sheen` | ✅ | Auto-detected (BJS-spec albedo scaling for glTF); or `createPbrMaterial({ sheen: { ... } })` |
| `KHR_materials_anisotropy` | ✅ | Auto-detected; or `createPbrMaterial({ anisotropy: { ... } })` |
| `KHR_materials_variants` | ✅ | `selectVariant(scene, name)`, `getVariantNames(scene)`, `resetVariant(scene)` |
| `KHR_materials_ior` | ✅ | Auto-detected; index of refraction for dielectrics (Scene 30) |
| `KHR_materials_specular` | ✅ | Auto-detected; dielectric specular intensity + color (Scene 30) |
| `KHR_materials_volume` | ✅ | Auto-detected; attenuation color/distance + thickness (Scene 30) |
| `KHR_materials_transmission` | ⚡ | Env-only refraction by default (Scene 30); Scene 112 uses the scene-scoped opaque RTT refraction helper for FlightHelmetKTX parity. |
| `KHR_texture_transform` | ✅ | Auto-resolved at load (material-wide UV transform) |
| `KHR_texture_basisu` | ✅ | Auto-detected; dynamically loads KTX2 decoder/upload path only for glTF assets that declare the extension (Scene 112) |
| `KHR_draco_mesh_compression` | ✅ | Auto-detected; loads `draco_decoder.js` + `.wasm` on demand from site root (override via `setDracoBaseUrl()`) |
| `KHR_materials_emissive_strength` | ✅ | Auto-detected; multiplies emissive output (Scene 31) |
| `KHR_materials_unlit` | ✅ | Auto-detected; emits base color directly with no lighting (Scene 32) |
| `KHR_lights_punctual` | ✅ | Auto-detected; point / spot / directional lights baked from glTF nodes (Scene 33) |
| `KHR_node_visibility` | ✅ | Auto-detected; per-node visibility flag honoured at render time (Scene 34) |
| `KHR_animation_pointer` | ✅ | Auto-detected; animates arbitrary JSON pointers (e.g. node visibility, material UBO fields) (Scene 34) |
| `EXT_mesh_gpu_instancing` | ✅ | Auto-detected; per-node TRS accessors expanded into thin instances (Scene 35) |
| Subsurface translucency + thickness | ✅ | `createPbrMaterial({ subsurface: { translucency, thickness } })` |
| Specular anti-aliasing | ✅ | Auto-on for glTF; manual: `createPbrMaterial({ enableSpecularAA: true })` |
| Morph targets | ✅ | PBR meshes only (not `StandardMaterial`) |
| Skeletal animation (4 or 8 bones) | ✅ | Driven by `createAnimationController(scene)` |
| Screen-space SSS (PrePass) | ❌ | Not implemented — only BRDF-layer translucency |

See `lab/src/lite/scene*.ts` for end-to-end examples of each extension in action.

