# Rectangular Area Lights

`RectAreaLight` adds a solid-color or textured rectangular emitter to PBR and Standard
materials. Like other Lite lights, it is scene-free state: create it, edit its
properties, then add it to the scene.

```typescript
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createPbrMaterial,
    createRectAreaLight,
    createSceneContext,
    createSphere,
    enableRectAreaLights,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera({ x: 0, y: 2, z: -6 }, { x: 0, y: 1, z: 0 });

const sphere = createSphere(engine);
sphere.position.y = 1;
sphere.material = createPbrMaterial({
    baseColorFactor: [0.8, 0.2, 0.1, 1],
    metallicFactor: 0.5,
    roughnessFactor: 0.25,
});
addToScene(scene, sphere);

const light = createRectAreaLight([0, 2, 3], 4, 2, 3);
light.diffuse = [1, 1, 1];
light.specular = [1, 1, 1];
addToScene(scene, light);

await enableRectAreaLights(scene);
await registerScene(scene);
await startEngine(engine);
```

## Orientation, dimensions, and materials

- `createRectAreaLight(position, width, height, intensity = 1)` takes an
  `[x, y, z]` position. `width` and `height` are nonnegative **full dimensions**
  in the light's local X/Y plane, not half-extents or world-space bounds.
  A zero width or height produces a dark, degenerate emitter.
- An unrotated emitter illuminates its **local −Z** side. Its +Z back face does
  not emit. Rotate `light.rotationQuaternion` to aim it; edit `light.position`,
  `light.scaling`, or `light.parent` just like other scene nodes. Parent rotation
  and nonuniform scaling affect the rectangle. The light itself draws no panel:
  add an emissive mesh separately if the source should be visible.
- `diffuse`, `specular`, `intensity`, `width`, and `height` are mutable state.
  PBR uses `metallicFactor`, `roughnessFactor`, and `baseColorFactor`; Standard
  uses `diffuseColor`, `specularColor`, and `roughness` for the LTC lookup.
  Standard `specularPower` continues to control ordinary point/spot highlights;
  it does not replace area-light roughness.
- Rectangular lights can coexist with point, directional, spot, and hemispheric
  lights; normal light-selection rules still apply.

## Textured emission

Load a source image, process it, then assign the **processed** `Texture2D` to
`light.emissionTexture`. This changes the illumination of receiving materials;
putting a texture on an emissive panel alone does not create a light.

```typescript
import { addToScene, createRectAreaLight, enableRectAreaLights, loadTexture2D, processAreaLightTexture, registerScene, startEngine } from "@babylonjs/lite";

// engine, scene, camera, and receiver meshes are set up as in the example above.
const source = await loadTexture2D(engine, "https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/Cyberpunk_AI_Square.png", {
    srgb: false,
});
const processed = await processAreaLightTexture(engine, source);
const light = createRectAreaLight([0, 2, 3], 4, 2, 3);
light.emissionTexture = processed;
addToScene(scene, light);

await enableRectAreaLights(scene);
await registerScene(scene);
await startEngine(engine);
```

`processAreaLightTexture(engine, source): Promise<Texture2D>` is the standalone
equivalent of Babylon.js `AreaLightTextureTools.processAsync(source)`. It produces
a separate 1024×1024 RGBA8 texture with eleven progressively blurred mip levels
and trilinear clamp sampling. It does not change the source sampler or transfer
ownership of the source. Do not assign the original image directly: initialization
rejects unprocessed, invalid, released, or wrong-device emission textures.

Use `{ srgb: false }` for the source to match Babylon.js processing in display-RGB
byte space; enabling hardware sRGB decoding changes the light's emission. Raster
`loadTexture2D` defaults already match Babylon.js's Y orientation, linear filtering,
and mipmap generation. Keep those defaults for the reference scenes rather than
adding another V flip. Processed output is an immutable emission snapshot: its UV
transform fields are not an emitter transform, and changing source pixels does
not update it automatically.

### Ownership and changes after registration

- The source and processed result each have their own caller-owned texture
  reference. Use the public `releaseTexture(texture)` when that reference is no
  longer needed; never destroy underlying GPU resources yourself.
- Processing keeps no persistent source reference. You can release the source
  after processing if nothing else uses it. If a visible panel uses the source,
  retain it through that material's registration instead.
- `light.emissionTexture` is **borrowed** state, not an ownership transfer.
  Multiple lights and cloned lights may share one processed texture. Successful
  `enableRectAreaLights(scene)` retains the selected processed textures for that
  scene's snapshot, so the caller can then release its result reference. Scene
  disposal releases scene-held references; disposal does not release references
  still owned by the application or another scene.
- Live light position, rotation, scaling, dimensions, colors, and intensity
  continue to update normally. Replacing or clearing `emissionTexture`, or changing
  the light list/order, requires another preparation and a renderable rebuild.
  Pause a running engine before these changes so it cannot render an intermediate
  combination of light slots and texture bindings:

```typescript
import { enableRectAreaLights, rebuildSceneRenderables, startEngine, stopEngine } from "@babylonjs/lite";

stopEngine(engine);
light.emissionTexture = null; // Return this emitter to solid-color illumination.
await enableRectAreaLights(scene);
await rebuildSceneRenderables(scene);
await startEngine(engine);
```

To change the emitted image, process the updated source again, assign the new
result, then await the same preparation/rebuild sequence. Do not mutate the
processed texture's pixels or try to reuse a released handle. Balance each
caller-owned reference once, including when replacing a map.

## Initialization and network requirements

Call and **await `enableRectAreaLights(scene)` before `registerScene(scene)`**.
This opt-in prepares the material support and uploads the exact Babylon.js
linearly transformed cosine (LTC) lookup tables; do not mark a scene ready until
initialization and its first rendered frame have completed.

The first initialization needs access to:

```text
https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin
```

Allow that HTTPS origin and your emission-image origin in your application's
network/CSP policy, with image CORS enabled for decoding. The lookup data is an
external asset, not an emission texture. Loading, preprocessing, and initialization
failures reject their promises; surface the error rather than rendering a
partially ready scene. Await every emission-processing operation, LTC preparation,
registration, and the first frame before declaring readiness.

The current milestone supports **solid-color and processed textured emission**.
It does not support area-light shadows, emission-texture serialization, or
importing serialized Babylon.js scenes. Use supported non-area shadow lights
separately when needed. Layered PBR materials are not supported with rectangular
area lights yet.
Lit Node Material graphs are not supported with rectangular area lights yet;
initialization rejects those combinations rather than silently misrendering.

## Reference scenes

| Scene                                                               | Source / coverage                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [316 PBR](../../lab/lite/src/lite/scene316.ts)                      | Upstream `areaLightsPBRMaterial`, Playground [`#T7FXR8#12`](https://playground.babylonjs.com/#T7FXR8#12).                        |
| [317 Standard](../../lab/lite/src/lite/scene317.ts)                 | Upstream `areaLightsStandardMaterial`, Playground [`#T7FXR8#67`](https://playground.babylonjs.com/#T7FXR8#67).                   |
| [318 Transforms and Materials](../../lab/lite/src/lite/scene318.ts) | Scaled/rotated parent, light-local rotation, mixed lights, back-face rejection, and white/tinted dielectric/metal pairs.         |
| [319 Textured Standard](../../lab/lite/src/lite/scene319.ts)        | Upstream `Textured - Area Lights - Standard Material`, Playground [`#T7FXR8#103`](https://playground.babylonjs.com/#T7FXR8#103). |
| [320 Textured PBR](../../lab/lite/src/lite/scene320.ts)             | Upstream `Textured - Area Lights - PBR`, Playground [`#T7FXR8#102`](https://playground.babylonjs.com/#T7FXR8#102).               |

The metallic/albedo pairs cover the regression fixed by
[Babylon.js PR #16723](https://github.com/BabylonJS/Babylon.js/pull/16723).

Scenes 316/317 preserve the upstream camera pose, receiver geometry, material
values, colored emitter transforms, and panel parenting. Only diagnostic
`AxesViewer` arrows are omitted in **both** engines. Lite's free camera matches
the upstream FlyCamera's initial view; interactive navigation is not part of
the comparison. Standard ignores the original snippet's dynamic `metallic`
assignments, so those no-op assignments are not ported.
For scene 318, the Babylon.js reference uses a child transform for the emitter's
local yaw, because its light has no local quaternion property; Lite stores that
same rotation directly on the light's `SceneNode`.
The reference panel also inherits this child transform directly, rather than
the Babylon.js light's untranslated child frame; its world placement matches
Lite's panel parented to the light.

Scenes 319/320 preserve the upstream panel scale of two, light dimensions and
intensities, parent transforms, receiver geometry, camera poses, and original
image URLs. Their source snippets are the current Babylon.js visualization
entries whose reference images are `textureAreaLightStandard.png` and
`texturedAreaLightsPBR.png`. Scene 319 uses `Cyberpunk_AI_Square.png`; scene 320
uses separate `White.png`, `Cyberpunk3_AI_Square.png`, and `Grey.png` maps from
[the upstream asset folder](https://github.com/SergioRZMasson/TemporaryAssetsRepo/tree/main/Textures).
Only diagnostic axes are omitted symmetrically. The Standard snippet's dynamic
`metallic` and `albedoColor` assignments have no effect in Babylon.js, so both
engines preserve the default white diffuse color; its actual roughness values
remain 0.2 and 0.9.

The corresponding Babylon.js references live in `lab/lite/src/bjs/scene316.ts`
through `scene320.ts`. All five scenes are static and signal
`canvas.dataset.ltcReady` after initialization and `canvas.dataset.ready` after
the first frame. Textured scenes additionally signal `canvas.dataset.emissionReady`
after every emission map has been processed. Their parity tests read committed
immutable goldens; they never navigate to a Babylon.js reference or regenerate
images at test time.

In the [Playground](../../playground/README.md), choose **Lights — Textured area
light** to run a compact root-API example with colored emitted illumination and
an optional source-image panel.
