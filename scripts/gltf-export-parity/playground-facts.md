# Babylon.js "GLTF Serializer" visualization tests — playground facts

> Temporary handoff material for the glTF-export parity scenes — delete before merging.

Source: `packages/tools/tests/test/visualization/config.json` (Babylon.js master @ 676f462) + the snippets on
snippet.babylonjs.com (code obtained as exact structured descriptions; one snippet verbatim).
Official reference images (600×400): `<GLTF_PARITY_WORK>/bjs-reference-images/<name>` (see `build-asset-mirror.sh`).

## How Babylon.js runs these tests (visualizationPlaywright.utils.ts)

- Viewport 600×400; page screenshot compared with Playwright `toHaveScreenshot`: per-pixel `threshold: 0.035`,
  `maxDiffPixelRatio: errorRatio/100` (errorRatio default **1.1**).
- WebGPU engine options: `{ enableAllFeatures: true, setMaximumLimits: true, antialias: false }`; WebGL2 engine: antialias false.
  `engine.renderEvenInBackground = true`.
- Before running the snippet: `window.seed = 1; Math.random = () => { const x = Math.sin(seed++) * 10000; return x - Math.floor(x); }`
  and `SceneLoader.ShowLoadingScreen = false`.
- `replace` config: comma-separated pairs `source, destination, source, destination…`; each `source` is replaced (first occurrence,
  `String.prototype.replace`) by `destination` in the snippet code. `"//options//, X;"` therefore inserts `X` where the
  `//options//` comment is (after the option variables are declared, overriding them).
- Relative `textures/…` and `scenes/…` URLs resolve to `https://playground.babylonjs.com/textures/…` / `/scenes/…`.
- Render: `scene.useConstantAnimationDeltaTime = true`; `scene.executeWhenReady(...)`, then render `renderCount` frames
  (default **1**), stop, screenshot.
- `engine` and `canvas` are globals provided by the harness.

---

## 1. #KX53VK#88 — "Triangle Winding Test" (Negative World Matrix)

Tests (all → `glTFSerializerNegativeWorldMatrix.png`, errorRatio 1.1):

- left handed, once: replace `//options//` → `useRightHandedSystem = false; iterations = 1;`
- left handed, twice: `useRightHandedSystem = false; iterations = 2;`
- right handed, once / twice: `useRightHandedSystem = true; …` (Lite has no right-handed scenes)

Code facts:

- Top-level: `let useRightHandedSystem = false; let iterations = 1; //options//`
- `const positions = { CCW: [0,0,0, 1,0,0, 0,1,0], CW: [0,0,0, 0,1,0, 1,0,0] }`;
  `const colors = [1,0,0,1, 0,1,0,1, 0,0,1,1]`; `const indices = [0,1,2]`.
- `clear(scene)`: `scene.meshes.slice().forEach(m => m.dispose(false, true))`.
- `createTriangle(scene, name, x, y, z, sideOrientation, addInvertedParent)`:
    - `parent = null`; if `addInvertedParent`: `parent = new BABYLON.Mesh("InvertNode", scene); parent.scaling.z = -1; parent.rotation.y = Math.PI;`
    - `mesh = new BABYLON.Mesh(name, scene, parent)`; `mesh.position.set(x, y, z)`.
    - `vertexData = new BABYLON.VertexData()`; `positions = positions[sideOrientation]`; `colors = colors`; `indices = indices`; `normals = []`.
    - `BABYLON.VertexData.ComputeNormals(vertexData.positions, indices, normals, { useRightHandedSystem: scene.useRightHandedSystem === (sideOrientation === "CCW") })`; `vertexData.normals = normals`.
    - `vertexData.applyToMesh(mesh)`.
    - `mesh.material = new BABYLON.PBRMaterial("material_" + name, scene)`; `metallic = 0`; `roughness = 1`;
      `mesh.material.sideOrientation = sideOrientation === "CCW" ? Material.CounterClockWiseSideOrientation : Material.ClockWiseSideOrientation`.
- `exportThenImportAsync(scene, toFile)`: `shouldExportNode = node => !(node instanceof BABYLON.Light)`;
  `GLTF2Export.GLBAsync(scene, "geometry", { shouldExportNode })` → `clear(scene)` → `file = new File([response.files["geometry.glb"]], "geometry.glb")`
  → `container = await BABYLON.LoadAssetContainerAsync(file, scene)` → `container.addAllToScene()`.
- `createScene()`: `scene = new BABYLON.Scene(engine)`; `scene.useRightHandedSystem = useRightHandedSystem`;
  camera `new BABYLON.ArcRotateCamera("Camera", -Math.PI/2, Math.PI/2, 4, new BABYLON.Vector3(0, 0.5, 0), scene)`; `camera.attachControl(canvas, true)`;
  light `new BABYLON.DirectionalLight("Light", new BABYLON.Vector3(0, 0, 1), scene)` (defaults);
  triangles: `createTriangle(scene, "CCW", -1, 1, 0, "CCW", false)`, `("CW", 1, 1, 0, "CW", false)`,
  `("CCW_Inverted", -1, -1, 0, "CCW", true)`, `("CW_Inverted", 1, -1, 0, "CW", true)` (each inverted triangle gets its own InvertNode);
  then `iterations` sequential `exportThenImportAsync(scene, false)`; return scene. No clear color set.

## 2. #KX53VK#85 — Shared Buffer Conversions

Test: `glTFSerializerSharedBufferConversions.png`, replace `//options//` → `meshCount = 2;` (errorRatio 1.1).

Verbatim code:

```text
let meshCount = 3; // Since conversions often involve negating signs, try this with odd and even numbers of meshes
//options//

function clear(scene) {
    scene.meshes.slice().forEach(function (mesh) {
        mesh.dispose(false, true);
    });
}

const positions = [ // CCW
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
];

const colors = [
    1, 0, 0, 1,
    0, 1, 0, 1,
    0, 0, 1, 1,
];

const indices = [
    0,
    1,
    2
];

let normals = []
BABYLON.VertexData.ComputeNormals(positions, indices, normals);

function createGeometry() {
    const geometry = new BABYLON.Geometry("shared");
    geometry.setVerticesBuffer(new BABYLON.VertexBuffer(engine, positions, BABYLON.VertexBuffer.PositionKind))
    geometry.setVerticesBuffer(new BABYLON.VertexBuffer(engine, colors, BABYLON.VertexBuffer.ColorKind))
    geometry.setVerticesBuffer(new BABYLON.VertexBuffer(engine, normals, BABYLON.VertexBuffer.NormalKind))
    geometry.setIndices(indices);
    return geometry;
}

function createTriangle(scene, name, x, y, z, geometry) {
    // Mesh
    const mesh = new BABYLON.Mesh(name, scene);
    mesh.position.set(x, y, z);
    geometry.applyToMesh(mesh);

    // Material
    mesh.material = new BABYLON.PBRMaterial("material_" + name, scene);
    mesh.material.metallic = 0;
    mesh.material.roughness = 1;
}

async function exportThenImportAsync(scene, toFile) {
    console.log("Exporting scene to GLTF, then loading GLTF");
    const shouldExportNode = (node) => !(node instanceof BABYLON.Light);
    const response = await BABYLON.GLTF2Export.GLBAsync(scene, "geometry", { shouldExportNode });

    clear(scene);

    let blob = response.files['geometry.glb'];
    let file = new File([blob], 'geometry.glb');

    if (toFile) {
        response.downloadFiles();
    }

    const container = await BABYLON.LoadAssetContainerAsync(file, scene);
    container.addAllToScene();
}

async function createScene() {
	// Initialize Scene
    const scene = new BABYLON.Scene(engine);
	const camera = new BABYLON.ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 2, 3, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    const light = new BABYLON.DirectionalLight("Light", new BABYLON.Vector3(0, 0, 1), scene);

    const geometry = createGeometry();

    for (let i = 0; i < meshCount; i++) {
        createTriangle(scene, i, -1 + i % 2, -Math.floor(i / 2), 0, geometry);
    }

    await exportThenImportAsync(scene, false)
    return scene;
};
```

## 3. #DMZBX1#1 / #DMZBX1#2 — Skinning and Animation (LH / RH) — `gltfSerializerSkinningAndAnimation.png`

Loads Xbot.glb (assets server), exports, disposes, reloads, fly camera + dimmed hemispheric light, loops the "run"
animation group. **Skins are out of scope for the Lite exporter → not ported.**

## 4. #84M2SR#107 — Morph Target Animation — `gltfSerializerMorphTargetAnimation.png`, `excludedEngines: ["webgpu"]`

- `createScene()`: `scene = new BABYLON.Scene(engine)`.
- `sphere1 = BABYLON.MeshBuilder.CreateSphere("sphere1", { segments: 16, size: 2 }, scene)`. `size` is not a sphere option, so all three spheres keep the default diameter 1; the reference image confirms it.
- `mat = new BABYLON.StandardMaterial("mat", scene)`; `mat.diffuseTexture = new BABYLON.Texture("textures/misc.jpg", scene)`; `sphere1.material = mat`.
- `sphere2 = CreateSphere("sphere2", { segments: 16, size: 2 }, scene)`; `sphere2.setEnabled(false)`;
  `sphere2.updateMeshPositions(positions => { for (i…) positions[i] += 0.2 * Math.random(); })` (every element).
- `sphereYStretched = CreateSphere("sphereYStretch", { segments: 16, size: 2 }, scene)`; `setEnabled(false)`;
  scaling `new Vector3(1, 3, 1)`; `updateMeshPositions`: for each vertex (step 3): `v = Vector3.FromArray(positions, i)`; multiply by scaling componentwise; write back.
- `manager = new BABYLON.MorphTargetManager()`; `sphere1.morphTargetManager = manager`.
- `target0 = BABYLON.MorphTarget.FromMesh(sphere2, "sphere2", 0.25)`; `manager.addTarget(target0)`;
  `target1 = MorphTarget.FromMesh(sphereYStretched, "sphereYStretched", 0.25)`; `manager.addTarget(target1)`.
- `sphere2.dispose(); sphereYStretched.dispose();`
- Animations (24 fps, ANIMATIONTYPE_FLOAT, ANIMATIONLOOPMODE_CYCLE, property "influence"):
    - `"sphereMorphTarget0_animation"` keys `{0:0},{24:1},{48:0}` → `target0.animations.push(...)`
    - `"sphereMorphTarget1_animation"` keys `{0:1},{12:0},{24:1},{36:0},{48:1}` → `target1.animations.push(...)`
- `downloadFile = false`; `assetName = "morphTargetTest"`.
- `GLTF2Export.GLBAsync(scene, assetName)` → `scene.dispose()` → `file = new File([glTFFiles["morphTargetTest.glb"]], "morphTargetTest.glb")`.
- `SceneLoader.OnPluginActivatedObservable.addOnce(loader => { loader.animationStartMode = GLTFLoaderAnimationStartMode.NONE; })`.
- `SceneLoader.LoadAsync("file:", file, engine)` → `outScene.createDefaultCameraOrLight(true, true, true)`;
  `outScene.activeCamera.radius *= 2`;
  `outScene.animationGroups[0].start(true, 1, 60, 60, true); outScene.animationGroups[0].setWeightForAllAnimatables(1);`
  same for `animationGroups[1]`; return `outScene`.

## 5. #T087A8#29 — Morph Target Animation Group — `gltfSerializerMorphTargetAnimationGroup.png`, excluded webgl1

- `scene = new BABYLON.Scene(engine)`; `downloadFile = false`; `scene.useRightHandedSystem = true`.
- `camera = new BABYLON.FlyCamera("camera1", new Vector3(0, 1, 5), scene)`; `speed = 0.5`; `setTarget(Vector3.Zero())`; `attachControl(canvas, true)`.
- `light = new BABYLON.HemisphericLight("light", new Vector3(0, 1, 0), scene)`; `intensity = 0.7`.
- `SceneLoader.LoadAssetContainerAsync("https://models.babylonjs.com/", "alien.glb", scene)` → `container.addAllToScene()`.
- `GLTF2Export.GLBAsync(scene, "alien2")` → `scene.dispose()` → `file = new File([glTFFiles["alien2.glb"]], "alien2.glb")`
  → `SceneLoader.LoadAsync("file:", file, engine)` → on `outScene`:
    - `camera = new BABYLON.ArcRotateCamera("camera1", Math.PI/2, Math.PI/2, 1.5, new Vector3(0, -0.2, 0), outScene)`; `attachControl(canvas, true)`.
    - `light = new BABYLON.HemisphericLight("light", new Vector3(0, 1, 0), outScene)`; `intensity = 0.7`.
    - `mat0 = outScene.materials[0]`; `mat1 = mat0.clone("mat1")`; `mat2 = mat0.clone("mat2")`; `mat3 = mat0.clone("mat3")`.
    - assign by mesh name: AlienHead→mat0; Collar, CollarClasp, Shirt, ShirtPlate, Teeth→mat1; LeftEye→mat2; RightEye→mat3.
    - `outScene.animationGroups[0].goToFrame(5 * outScene.animationGroups[0].targetedAnimations[0].animation.framePerSecond)`;
      `outScene.animationGroups[0].pause()`; return `outScene`.

## 6. #F8BF8N#3 — KHR draco mesh compression — `glTFSerializerKhrDracoMeshCompression.png`

- `const roundtrip = true; const exportFileName = "exported";`
  `const exportOptions = { shouldExportNode: node => !(node instanceof BABYLON.Light || node instanceof BABYLON.Camera), meshCompressionMethod: "Draco" };`
- `createScene`: `scene = new BABYLON.Scene(engine)`; `await BABYLON.SceneLoader.AppendAsync("scenes/Alien/", "Alien.gltf", scene)`;
  `scene.createDefaultLight()`; `scene.createDefaultCamera(true, true, true)`; `scene.activeCamera.alpha += Math.PI`;
  `scene.activeCamera.radius = 1.25`; if roundtrip `await exportThenImportAsync(scene)`; return scene.
- `exportThenImportAsync`: `glbData = await GLTF2Export.GLBAsync(scene, "exported", exportOptions)`; `file = new File([glbData.files["exported.glb"]], "exported.glb")`;
  `scene.getNodes().slice().forEach(node => { if (exportOptions.shouldExportNode(node)) node.dispose(); })`;
  `container = await SceneLoader.LoadAssetContainerAsync("file:", file, scene)`; `container.addAllToScene()`.
- Lite writes no Draco (compressed output is out of scope); a Lite port exports plain accessors.

## 7. #9N6CLU#23 — KHR materials clearcoat — `glTFSerializerKhrMaterialsClearcoat.png`, excluded webgl1

- Helpers: `_createBase64FromCanvasAsync(buffer, width, height, mimeType, scene)`: raw RGBA texture
  (`engine.createRawTexture(buffer, w, h, TEXTUREFORMAT_RGBA, false, true, Texture.NEAREST_SAMPLINGMODE, null, TEXTURETYPE_UNSIGNED_INT)`),
  `TextureTools.ApplyPostProcess("pass", tempTexture, scene, TEXTURETYPE_UNSIGNED_INT, TEXTURE_NEAREST_SAMPLINGMODE, TEXTUREFORMAT_RGBA)`,
  `engine._readTexturePixels(tex, w, h)`, `Tools.DumpDataAsync(w, h, data, mimeType, undefined, true, false)` → base64.
  `combineRoughnessIntensityTextures(intensityTexture, roughnessTexture, scene)`: `size = intensityTexture.getSize()`;
  `await readPixels()` on both; `combined` Uint8Array same length: R = intensity.R, G = roughness.G, B = 0, A = 255;
  → base64 PNG → `new BABYLON.Texture(base64, scene)`.
- `createScene`: `scene = new BABYLON.Scene(engine)`; `downloadFile = false`;
  `cameraLocation = new Vector3(2, -1, 20)`; `cameraTarget = new Vector3(cameraLocation.x, cameraLocation.y, 0)` = (2, -1, 0);
  `camera = new BABYLON.UniversalCamera("camera1", cameraLocation.clone(), scene)`; `speed = 0.5`; `setTarget(cameraTarget.clone())`; `attachControl(canvas, true)`;
  `light = new BABYLON.HemisphericLight("light", new Vector3(0, 1, 0), scene)` (default intensity);
  `envTexture = new BABYLON.CubeTexture("/textures/environment.dds", scene)`; `scene.createDefaultSkybox(envTexture, true, 1000)`;
  `assetName = "KHR_materials_clearcoat_test"`.
- `SceneLoader.LoadAssetContainerAsync("https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/ClearCoatTest/glTF-Binary/ClearCoatTest.glb", "", scene)` → `container.addAllToScene()`.
- Post-load: clone node `"R2_RoughnessVariations"` → `"R6_CombinedIntensityRoughnessTextures"`; `position.y = -7.35`; `scaling.x = -1`.
  `roughnessMat = scene.getMaterialByName("RoughVariations_Coated")`; `intensityMat = getMaterialByName("Partial_Coated")`;
  `roughnessTexture = roughnessMat.clearCoat.textureRoughness`; `intensityTexture = intensityMat.clearCoat.texture`;
  `combined = await combineRoughnessIntensityTextures(intensityTexture, roughnessTexture, scene)`; `combined.name = "CombinedRoughnessIntensity_Coated"`;
  `newMat = roughnessMat.clone(...)`; `newMat.clearCoat.isEnabled = true`; `clearCoat.texture = combined`; `clearCoat.textureRoughness = null`; `clearCoat.useRoughnessFromMainTexture = true`.
  Meshes by name `"undefined.R2_BaseLayerSample"`, `"undefined.R2_ClearCoatSample"`, `"undefined.R2_CoatOnlySample"` (the clones' meshes):
  BaseLayer: `material = material.clone("SharedIntensityRoughness_Base")`; ClearCoat: `material = newMat` named `"SharedIntensityRoughness_Coated"`;
  CoatOnly: `material = material.clone("SharedIntensityRoughness_Coating")`, `albedoTexture = getMaterialByName("Partial_Coating").albedoTexture`,
  `useAlphaFromAlbedoTexture = true`, `transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND`.
- Export: `GLTF2Export.GLBAsync(scene, "KHR_materials_clearcoat_test2")` → `scene.dispose()` → `SceneLoader.LoadAsync("file:", file, engine)` →
  on outScene: UniversalCamera "camera1" at cameraLocation clone, speed 0.5, target cameraTarget clone, attachControl;
  HemisphericLight "light" (0,1,0) `intensity = 0.7`; CubeTexture "/textures/environment.dds" + `createDefaultSkybox(envTexture, true, 1000)`; return outScene.

## 8. #1Q2BWN#10 — KHR gpu instancing — `glTFSerializerKhrGpuInstancing.png`

- `scene = new BABYLON.Scene(engine)`; `cameraLocation = new Vector3(0, 50, -100)`; `cameraTarget = Vector3.Zero()`;
  `camera = new BABYLON.UniversalCamera("camera1", cameraLocation, scene)`; `setTarget(cameraTarget)`; `attachControl(canvas, true)`;
  `lightDirection = new Vector3(0, 1, 0)`; `light = new BABYLON.HemisphericLight("light", lightDirection, scene)`; `intensity = 0.7`;
  `assetName = "KHR_gpu_instancing"`.
- `return SceneLoader.AppendAsync("https://models.babylonjs.com/TeapotsGalore/", "TeapotsGalore.gltf", scene).then(() =>
 GLTF2Export.GLBAsync(scene, "KHR_gpu_instancing2").then(r => { file = new File([r.glTFFiles["KHR_gpu_instancing2.glb"]], "KHR_gpu_instancing2.glb");
 return SceneLoader.LoadAsync("file:", file, engine).then(outScene => { UniversalCamera "camera1" at cameraLocation.clone(), setTarget(cameraTarget.clone()), attachControl;
 HemisphericLight "light" lightDirection.clone(), intensity 0.7; return outScene; }) }))`. The original scene is not disposed.

## 9. #FLXW8B#27 — KHR punctual light — LH: `glTFSerializerKHRPunctualLightLH.png` (replace `//options//` → `roundtrip = true; useRightHandedSystem = false;`), RH: `…RH.png`

- Top-level: `let roundtrip = true; let useRightHandedSystem = true; let downloadGLTF = false; //options//` (placeholder after these),
  `let shouldExportNode = node => node instanceof BABYLON.Light`; `const exportFileName = "exported"`.
- `createCameraAndPlane(scene)`: `new BABYLON.ArcRotateCamera("camera", Math.PI/2, Math.PI/4, 8, BABYLON.Vector3.Zero(), scene)`; `attachControl(canvas, true)`;
  `ground = BABYLON.MeshBuilder.CreateGround("Ground", { width: 5, height: 5 })`; `mat = new BABYLON.PBRMaterial("mat")`; `mat.roughness = 0.66`; `ground.material = mat`.
- `createLights(scene)`:
    - `new BABYLON.DirectionalLight("directional", new Vector3(-1, -1, -1), scene)`; `intensity = 0.2`; `falloffType = BABYLON.Light.FALLOFF_GLTF`.
    - `new BABYLON.PointLight("point", new Vector3(2, 2, 2), scene)`; `falloffType = FALLOFF_GLTF`.
    - `new BABYLON.SpotLight("spot", new Vector3(-2, 2, -2), new Vector3(2, -2, 2), 30, 2, scene)` (angle 30 — radians, as written); `falloffType = FALLOFF_GLTF`.
- `createScene` (async): `scene = new BABYLON.Scene(engine)`; `scene.useRightHandedSystem = useRightHandedSystem`; `createCameraAndPlane(scene)`; `createLights(scene)`;
  if roundtrip `await exportThenImportAsync(scene)`; return scene.
- `exportThenImportAsync`: `glbData = await GLTF2Export.GLBAsync(scene, "exported", { shouldExportNode })`; `file = new File([glbData.glTFFiles["exported.glb"]], "exported.glb")`;
  (download branch off); `scene.getNodes().slice().forEach(n => { if (shouldExportNode(n)) n.dispose(); })` (removes the lights);
  `container = await SceneLoader.LoadAssetContainerAsync("file:", file, scene)`; `container.addAllToScene()`.
  Only the lights round-trip; camera, ground and material stay.

## 10. #O0M0J9#25 — Camera (4 tests) — `glTFSerializerCameraLeftHand.png` / `…RightHand.png`

Two cameras (FreeCamera "camera1" + ArcRotateCamera "camera2") with split viewports, both exported. **Lite scenes have one
camera and the exporter exports only `scene.camera` → not portable without a multi-camera export decision.**

## 11. #UK7FLI#1 — Rotation conversion, left-handed — `glTFSerializerRotationConversionLH.png`

- `const roundtrip = true; const exportFileName = "exported";`
  `const exportOptions = { shouldExportNode: node => !(node instanceof BABYLON.Light || node instanceof BABYLON.Camera) };`
- `createRotatedParentChild(scene, xOffset, yOffset, parentQuaternion, childQuaternion)`: `parent = new BABYLON.TransformNode("parent", scene)`;
  `parent.position.set(xOffset - 1, yOffset - 0.5, 0)`; `parent.rotationQuaternion = parentQuaternion`;
  `child = BABYLON.MeshBuilder.CreateBox("child", { size: 1 }, scene)`; `child.parent = parent`; `child.rotationQuaternion = childQuaternion`.
- `createScene`: `scene = new BABYLON.Scene(engine)`; `scene.createDefaultLight()`; `scene.createDefaultCamera(true, true, true)`;
  `scene.activeCamera.alpha += Math.PI`; `scene.activeCamera.radius = 3`; then (Q = `BABYLON.Quaternion.FromEulerAngles`):
    1. `(0, 0, Q(-21, 42, 63), Q(0, 0, 0))`
    2. `(0, 1, Q(0, 0, 0), Q(-98, 56, 43))`
    3. `(1, 0, Q(-21, 42, 63), Q(34, -78, -121))`
    4. `(1, 1, Q(-21, -100, -87), Q(-159, -80, 42))`
    5. `(2, 0, Q(189, -33, -90), Q(-9, 56, 43))`
    6. `(2, 1, Q(0, 360, 0), Q(-34, -180, 43))`
       then `await exportThenImportAsync(scene)`; return scene.
- `exportThenImportAsync`: `GLBAsync(scene, "exported", exportOptions)`; file; dispose every node with `shouldExportNode(node)`;
  `SceneLoader.LoadAssetContainerAsync("file:", file, scene)`; `addAllToScene()`. Boxes use the default material.

## 12. #3A00GJ#42 — camera rotation animation (4 tests: RH→LH, RH→RH, LH→RH, LH→LH) — `glTFSerializerCameraRotationAnimation.png`

8 FreeCameras with rotation animation groups in a 4×2 viewport grid, GUI labels per camera layer, BoomBox ×200,
three PBR spheres, two hemispheric lights. **Needs 8 exported cameras + multi-viewport rendering → not portable (same
reason as #10).**

## 13. #8NTR5X#8 — un/compressed texture roundtrip — `glTFSerializerTextureExport.png`, replace `//options//` → `roundtrip = true;`, errorRatio 0.1

- `let roundtrip = false; //options//`.
- `createTexturedPlane(texture, position, suffix)`: `plane = BABYLON.MeshBuilder.CreatePlane("plane_" + suffix)` (default size 1, last scene);
  `plane.position.fromArray(position)`; `material = new BABYLON.PBRMaterial("material_" + suffix)`; `albedoTexture = texture`; `metallic = 0`; `roughness = 1`; `plane.material = material`.
- `createScene` (async): `scene = new BABYLON.Scene(engine)`; `scene.useDelayedTextureLoading = false`;
  `textureSources = ["textures/down.png", "textures/grass.jpg", "textures/ktx2/sample_uastc.ktx2", "textures/palm.png"]`;
  `commonTextureOptions = { invertY: false, useSRGBBuffer: true }`;
  `textureCreationMethods` (each `url => Promise<Texture>`): 0. `new BABYLON.Texture(url, scene, { onLoad: () => resolve(texture), ...commonTextureOptions })`
    1. `t = new BABYLON.Texture(null, scene, commonTextureOptions)`; `t.updateURL(url, undefined, () => resolve(t))`
    2. `t = new BABYLON.Texture(null, scene, { mimeType: BABYLON.GetMimeType(url), ...commonTextureOptions })`; `data = await BABYLON.Tools.LoadFileAsync(url)`; `t.updateURL("data:foo/" + url, data, () => resolve(t))`
    3. same as 2 but URL `"data:foo/" + BABYLON.Tools.RandomId()`
       For every source i and method j: `createTexturedPlane(await method(url), [j, i, 0], "original" + i + j)`; `await Promise.all(...)`.
       If roundtrip: `blob = (await GLTF2Export.GLBAsync(scene, "test")).files["test.glb"]`; every root node `dispose(false, true)`;
       `scene = await BABYLON.LoadSceneAsync(new File([blob], "test.glb"), engine)`.
       Then `scene.materials.forEach(m => m.debugMode = 20)` (PBR debug mode 20 = albedo texture rgb, output as gamma — i.e. unlit albedo).
       Camera: `new BABYLON.ArcRotateCamera("Camera", -Math.PI/2, Math.PI/2, textureSources.length * 1.2 /*4.8*/, new Vector3(textureSources.length/2 - 0.5, textureCreationMethods.length/2 - 0.5, 0) /*(1.5,1.5,0)*/, scene)`; `attachControl(canvas, true)`; return scene.

## 14. #KU72PX#0 — multimaterial with raw texture — `glTFSerializerMultimaterial.png`

- `createScene(engine)` (async): `let scene = new BABYLON.Scene(engine)`;
  `plane = BABYLON.MeshBuilder.CreateTiledPlane("plane", { tileSize: 1, width: 1, height: 2, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene)`; `plane.scaling.x = 2`;
  `verticesCount = plane.getTotalVertices()`; `totalFaces = verticesCount / 3`; `halfFaces = Math.floor(totalFaces / 2)`;
  `new BABYLON.SubMesh(0, 0, verticesCount, 0, halfFaces * 3, plane)`; `new BABYLON.SubMesh(1, 0, verticesCount, halfFaces * 3, (totalFaces - halfFaces) * 3, plane)`;
  `multiMat = new BABYLON.MultiMaterial("multi", scene)`;
  `pbr1 = new BABYLON.PBRMaterial("pbr1", scene)`; `rawTexture1 = new BABYLON.RawTexture(new Uint8Array([255,0,0,255, 0,255,0,255]), 2, 1, BABYLON.Engine.TEXTUREFORMAT_RGBA, scene, false, false, BABYLON.Texture.NEAREST_NEAREST_MIPNEAREST)`;
  `pbr1.albedoTexture = rawTexture1; metallic = 0.0; roughness = 1.0`;
  `pbr2` likewise with `[0,0,255,255, 255,255,0,255]`; `multiMat.subMaterials.push(pbr1, pbr2)`; `plane.material = multiMat`;
  `scene.createDefaultCamera(true, true, true)`;
  `light = new BABYLON.DirectionalLight("light", BABYLON.Vector3.Forward(), scene)`; `light.falloffType = BABYLON.Light.FALLOFF_GLTF`;
  `glbData = await GLTF2Export.GLBAsync(scene, "scene")`; `arrayBuffer = await glbData.files["scene.glb"].arrayBuffer()`; `scene.dispose()`;
  `scene = await BABYLON.LoadSceneAsync(new Uint8Array(arrayBuffer), engine, { pluginExtension: ".glb" })`;
  `scene.activeCamera = scene.cameras[0]`; return scene.

## 15. #20OAV9#15148 — Export GLTF Extension KHR_texture_transform — `exportGltfKHRTextureTransform.png`

- `createScene` returns a Promise: `scene = new BABYLON.Scene(engine)`;
  `light = new BABYLON.HemisphericLight("hemiLight", new Vector3(-1, 1, 0), scene)`; `light.diffuse = new Color3(1, 1, 1)`;
  textures, each `new BABYLON.Texture("https://i.imgur.com/JbvoYlB.png", scene)` as the `diffuseTexture` of a `StandardMaterial`:
  `mat0` (no transform); `mat1`: `wAng = 0.3; uRotationCenter = 0; vRotationCenter = 0`; `mat2`: `uOffset = 0.1; vOffset = 0.4`; `mat3`: `uScale = 2; vScale = 3`.
  `matList = [mat0, mat1, mat2, mat3]`; for i 0..3: `plane = MeshBuilder.CreatePlane("plane" + i, {}, scene)`; `material = matList[i]`; `position.x = 1.5 * i`.
  Camera `new BABYLON.ArcRotateCamera("Camera", -Math.PI/2, Math.PI/2, matList.length * 4 /*16*/, new Vector3(matList.length/2 * 1.5 /*3*/, 0, 0), scene)`; `attachControl(canvas, true)`.
  Then, in order:
    1. `scene.executeWhenReady(callback, true)`; in it, `GLTF2Export.GLBAsync(scene, "fileName", { shouldExportNode: (node) => node.name.startsWith("plane") })`.
    2. For each `key` in `glb.files`: `file = new File([glb.files[key]], key)`; `meshes = (await BABYLON.ImportMeshAsync(file, scene)).meshes`.
    3. For each mesh whose name starts with `"plane"`: `m.position.y -= 1.5`; `m.name = "imported_" + m.name`.
    4. `scene.executeWhenReady(() => resolve(scene), true)`.
       The originals stay at y = 0; the imported copies sit at y = -1.5.
