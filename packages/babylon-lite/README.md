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

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
createDefaultCamera(scene);

await registerScene(scene);
await startEngine(engine);
```

## Documentation

Full documentation is available at
[https://doc.babylonjs.com/lite/](https://doc.babylonjs.com/lite/).

## License

[Apache-2.0](./LICENSE)
