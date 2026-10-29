# Right-Handed Coordinate System

> 🧪 **Experimental.** The right-handed build covers the core rendering path today (see [What is covered](#what-is-covered)); the rest follows feature by feature.

Babylon Lite is **left-handed** by default, like Babylon.js. Babylon.js switches to a right-handed system at runtime with `scene.useRightHandedSystem = true`. Lite makes the same choice **when your application is compiled**: you add one resolve condition, `babylon-lite-rh`, to your bundler, and every engine in that bundle is right-handed.

Nothing else changes in your code: you keep calling `createEngine`, `createArcRotateCamera`, `loadGltf`… and the types are the same.

Why at build time? Because then it can cost nothing. The handedness is a constant the minifier folds away: a right-handed bundle carries only the right-handed code, and, with Rolldown (the bundler of the lab scenes, checked scene by scene), a left-handed bundle is byte-for-byte the one you had before this feature existed. Minifiers that do not inline an imported constant, such as esbuild's, keep the handedness checks and a few small helpers: the left-handed result is the same, the bundle is slightly larger. A runtime switch would add bytes to every scene, left-handed or not.

---

## 1. Compile right-handed

Add the `babylon-lite-rh` condition to your bundler's resolve conditions. Pick your bundler:

### Vite (6 and later)

```ts
// vite.config.ts
import { defineConfig, defaultClientConditions } from "vite";

export default defineConfig({
    resolve: {
        conditions: [...defaultClientConditions, "babylon-lite-rh"],
    },
});
```

`resolve.conditions` **replaces** Vite's defaults, so keep `...defaultClientConditions`. If you also render on the server (SSR), add the condition to `ssr.resolve.conditions` too, with `defaultServerConditions`.

### Vite 5 and earlier

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    resolve: {
        conditions: ["babylon-lite-rh"],
    },
});
```

### webpack 5

```js
// webpack.config.js
module.exports = {
    resolve: {
        conditionNames: ["babylon-lite-rh", "..."], // "..." keeps webpack's defaults
    },
};
```

### esbuild

```bash
esbuild app.ts --bundle --conditions=babylon-lite-rh,module --outfile=out.js
```

```js
await esbuild.build({ entryPoints: ["app.ts"], bundle: true, conditions: ["babylon-lite-rh", "module"], outfile: "out.js" });
```

Setting `conditions` replaces esbuild's default `module` condition, so list it again.

### Rollup

```js
// rollup.config.js
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
    input: "app.ts",
    plugins: [nodeResolve({ exportConditions: ["babylon-lite-rh"] })],
};
```

### Rolldown

```js
// rolldown.config.js
export default {
    input: "app.ts",
    resolve: { conditionNames: ["babylon-lite-rh", "import", "module", "browser", "default"] },
};
```

### How it works

`@babylonjs/lite` declares a private package import, `#coordinate-system`, in its `package.json`:

```json
"imports": {
    "#coordinate-system": {
        "babylon-lite-rh": "./lib/engine/coordinate-system-rh.js",
        "default": "./lib/engine/coordinate-system.js"
    }
}
```

Every engine module that depends on handedness imports its flag from `#coordinate-system`. Your bundler resolves that import once, with your conditions: with `babylon-lite-rh` it picks the right-handed file, otherwise the left-handed one. Any bundler that supports `package.json` `imports` and custom conditions works the same way.

Because of this import, the modules in `lib/` need a bundler that reads `package.json` `imports` (all those above do; bare Rollup needs `@rollup/plugin-node-resolve`). Native browser ESM cannot resolve `#coordinate-system` on its own: load the prebuilt `dist/index.js` instead, which is left-handed.

---

## 2. Check that it worked

Put a box on the **+X** side and look at it from **−Z**:

```ts
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 }); // camera at -Z
const box = createBox(engine);
box.position.x = 2;
```

- Left-handed build: the box is on the **right** of the canvas.
- Right-handed build: the box is on the **left**, exactly as in Babylon.js with `useRightHandedSystem = true`.

If the box is still on the right, the condition did not reach the bundler: check that the config you edited is the one your build uses, and, with Vite, restart the dev server with `--force` to rebuild its dependency cache.

---

## 3. What changes in a right-handed engine

It matches Babylon.js with `scene.useRightHandedSystem = true`:

- **Cameras** look down their local **−Z** axis; for the same position and target, the image is the mirror of the left-handed one.
- **glTF** assets keep glTF's native right-handed space: no mirroring root node, like Babylon.js.
- **Triangle winding**: front faces follow Babylon.js's right-handed rule, so back-face culling keeps working on glTF and procedural meshes alike, with PBR, Standard, Node and shader materials, including a glTF mesh switched from PBR to a Node or shader material with `enableMirroredMeshes()` on.
- **Environment lighting** (IBL) is oriented as in Babylon.js's right-handed scenes (except the glTF `EXT_lights_image_based` yaw, see [Limits](#limits)).

Port a right-handed Babylon.js scene by keeping its positions, rotations and camera angles as they are: the same numbers give the same image.

## What is covered

Everything in Lite that Babylon.js treats differently with `useRightHandedSystem = true`: cameras and their keyboard, mouse and touch inputs (arc-rotate, free, orthographic, geospatial, glTF and `.babylon` cameras), glTF loading (skinned, animated, morphed, embedded cameras, negative-scale nodes, Gaussian splats, interactivity camera paths), PBR, Standard, Node and shader materials, image-based lighting, skyboxes and reflections, shadows and cascaded shadows, screen-space effects that rebuild normals from depth (contact shadows, SSGI, cavity) and mesh blending, procedural meshes, CSG2, sprites and billboards (and their picking), gizmos, Havok mesh shapes, USD, and WebXR (poses, pointers, teleportation, hands and controller models).

The lab scenes listed below check most of them against Babylon.js. Gaussian splats, the screen-space effects (contact shadows, SSGI, cavity) and mesh blending have no right-handed lab scene yet: only unit pair tests check them, by comparing their right-handed result with the left-handed one. In every case the test suite fails whenever the left-handed code changes without its right-handed counterpart (see the [architecture page](architecture/61-right-handed-system.md#tests)).

## Limits

- **One handedness per bundle.** Every engine your bundle creates has the same handedness. Two pages that need different handedness need two builds.
- **`EXT_lights_image_based` is not ported.** A right-handed build applies the extension's environment rotation with the left-handed sign, so the environment is turned differently from Babylon.js's right-handed scene whenever that rotation is not 0° or 180°. Twin 342 (a 90° rotation) is therefore checked against its left-handed source's reference, not against Babylon.js right-handed.
- **The CDN build and the [Lite Playground](04-playground.md) are left-handed.** They are prebuilt with the default condition.

## See it in the lab

Scenes 321 to 347 of the lab gallery are right-handed twins of scenes 2, 5, 13, 28, 38, 11, 25, 250, 266, 268, 270, 4, 214, 72, 60, 159, 54, 94, 223, 225, 91, 265, 24, 143, 103, 149 and 9: the same Lite code, compiled with `babylon-lite-rh`, checked against the same Babylon.js reference with `useRightHandedSystem = true`.
For the implementation, see [Right-Handed System architecture](architecture/61-right-handed-system.md).
