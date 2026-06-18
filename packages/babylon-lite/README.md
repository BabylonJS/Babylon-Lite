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

## License

[Apache-2.0](./LICENSE)

`@babylonjs/lite` is a derivative of [Babylon.js](https://www.babylonjs.com/)
(Apache-2.0). It bundles a small number of third-party runtime libraries
(`manifold-3d`, `@recast-navigation/*`, `text-shaper`) whose code ships inside
the published package. Their license texts are reproduced in
[THIRD_PARTY_NOTICES.txt](./THIRD_PARTY_NOTICES.txt).

Development-only tooling (build, test, and lint frameworks) is **not** part of
the published package and therefore carries no redistribution obligations.
