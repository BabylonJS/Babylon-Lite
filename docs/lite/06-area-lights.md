# Rectangular Area Lights

`RectAreaLight` adds a solid-color rectangular emitter to PBR and Standard
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

## Initialization and network requirements

Call and **await `enableRectAreaLights(scene)` before `registerScene(scene)`**.
This opt-in prepares the material support and uploads the exact Babylon.js
linearly transformed cosine (LTC) lookup tables; do not mark a scene ready until
initialization and its first rendered frame have completed.

The first initialization needs access to:

```text
https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin
```

Allow that HTTPS origin in your application's network/CSP policy. The lookup
data is an external asset, not an emission texture. Initialization failures
reject the promise; surface the error rather than rendering a partially ready
scene.

The initial milestone supports **solid-color emission only**. It does not
support area-light shadows, textured emission, or importing serialized
Babylon.js scenes. Use supported non-area shadow lights separately when needed.
Lit Node Material graphs are not supported with rectangular area lights yet;
initialization rejects those combinations rather than silently misrendering.

## Reference scenes

| Scene                                                               | Source / coverage                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [316 PBR](../../lab/lite/src/lite/scene316.ts)                      | Upstream `areaLightsPBRMaterial`, Playground [`#T7FXR8#12`](https://playground.babylonjs.com/#T7FXR8#12).                |
| [317 Standard](../../lab/lite/src/lite/scene317.ts)                 | Upstream `areaLightsStandardMaterial`, Playground [`#T7FXR8#67`](https://playground.babylonjs.com/#T7FXR8#67).           |
| [318 Transforms and Materials](../../lab/lite/src/lite/scene318.ts) | Scaled/rotated parent, light-local rotation, mixed lights, back-face rejection, and white/tinted dielectric/metal pairs. |

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

The corresponding Babylon.js references live in `lab/lite/src/bjs/scene316.ts`
through `scene318.ts`. All three scenes are static and signal
`canvas.dataset.ltcReady` after initialization and `canvas.dataset.ready` after
the first frame. Their parity tests read committed immutable goldens; they
never navigate to a Babylon.js reference or regenerate images at test time.
