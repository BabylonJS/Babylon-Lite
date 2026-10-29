# Babylon Lite

A lightweight, tree-shakable, WebGPU-first rendering library derived from
[Babylon.js](https://www.babylonjs.com/). Import only what you use and ship a
minimal bundle.

## Installation

```bash
npm install @babylonjs/lite
```

## Quick start

```ts
import { createEngine, createSceneContext, createDefaultCamera, createHemisphericLight, addToScene, loadGltf, registerScene, startEngine } from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
    createDefaultCamera(scene);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
```

## OpenUSD

`loadUsd()` loads `.usd`, `.usda`, `.usdc`, and `.usdz` with the same
protocol-versioned OpenUSD WebAssembly extractor used by Babylon.js, then
materializes the command/data buffers as native Lite entities:

```ts
import { addToScene, loadUsd } from "@babylonjs/lite";

const asset = await loadUsd(engine, "/assets/model.usdz");
addToScene(scene, asset);
```

For composed stages, pass every external layer, payload, and texture through
the virtual `files` map while preserving authored paths:

```ts
const asset = await loadUsd(engine, rootLayer, {
    rootFileName: "Package/Scenes/Main.usda",
    files: {
        "Package/Layers/Geometry.usdc": geometryLayer,
        "Package/Textures/Albedo.png": albedo,
    },
});
```

The worker, glue, WASM, and data bundle default to the Babylon.js CDN. Set
`runtimeBaseUrl` to a directory containing all four protocol-v5 files to
self-host them.

## Documentation

Full documentation is available at
[https://doc.babylonjs.com/lite/](https://doc.babylonjs.com/lite/).

## Headless simulation (null engine)

Babylon Lite can run **without a GPU or canvas** for server-side physics,
deterministic simulation, or CI — the Lite analogue of Babylon.js `NullEngine`.
Use `createNullEngine()` instead of `createEngine()`, and drive the loop
yourself with `stepScene()`:

```ts
import { createNullEngine, stepScene, createSceneContext } from "@babylonjs/lite";

const engine = createNullEngine(); // no device, no canvas — synchronous
const scene = createSceneContext(engine, { defaultRenderTask: false });

// ...add physics bodies / onBeforeRender callbacks...

for (let i = 0; i < 180; i++) stepScene(engine, scene, 1000 / 60); // simulate 3s
```

It needs no WebGPU and runs on plain Node (recommended), Deno, Web Workers, or
CI. Rendering is out of scope. See the
[Headless (Null Engine) guide](https://doc.babylonjs.com/lite/05-headless-null-engine) for details,
supported runtimes, and limitations.

## Right-handed coordinate system

Babylon Lite is left-handed by default. To render right-handed, like Babylon.js
with `scene.useRightHandedSystem = true`, add the `babylon-lite-rh` resolve
condition to your bundler. Your code does not change, and the handedness is a
constant the minifier folds away: with Rolldown, which builds the lab scenes, a
left-handed bundle is byte-for-byte the one built before this option existed.
esbuild keeps the handedness checks and a few small helpers, so its bundles grow
slightly.

The modules in `lib/` import `#coordinate-system`, a package import declared in
this package's `imports` map. Bundlers that read `imports` (Vite, webpack 5,
esbuild, Rolldown, Rollup with `@rollup/plugin-node-resolve`) resolve it; native
browser ESM and bundlers without `imports` support do not. The prebuilt
`dist/index.js` has no such import and is left-handed.

```ts
// vite.config.ts
import { defineConfig, defaultClientConditions } from "vite";

export default defineConfig({
    resolve: { conditions: [...defaultClientConditions, "babylon-lite-rh"] },
});
```

Every engine in that bundle is right-handed. See the
[Right-Handed Coordinate System guide](https://doc.babylonjs.com/lite/07-right-handed-system) for
webpack, esbuild and Rollup, and for the features covered so far.

## License

[Apache-2.0](./LICENSE)

`@babylonjs/lite` is a derivative of [Babylon.js](https://www.babylonjs.com/)
(Apache-2.0). It bundles a small number of third-party runtime libraries
(`manifold-3d`, `@recast-navigation/*`, `text-shaper`) whose code ships inside
the published package. Their license texts — together with those of the
upstream native components embedded in their WebAssembly (Recast &amp; Detour and
the Emscripten runtime) — are reproduced in
[NOTICE.txt](./NOTICE.txt).

Development-only tooling (build, test, and lint frameworks) is **not** part of
the published package and therefore carries no redistribution obligations.
