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
