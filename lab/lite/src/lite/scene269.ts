// Scene 269: setParent() on a mirrored glTF root.
//
// Reproduces https://forum.babylonjs.com/t/lite-confusion-about-createnodetransform-and-negative-scaling/63859
// The glTF loader's synthetic `__root__` carries the RH->LH handedness flip as a negative
// scale, so its local transform has a NEGATIVE determinant. Reparenting it under a freshly
// created transform node goes through setParent(), which rebuilds the local TRS from
// inverse(parentWorld) * childWorld. A decomposition that returns only non-negative scales
// silently drops the reflection and renders the whole model mirrored.
//
// The asset (glTF-Asset-Generator Node_NegativeScale_01) also contains its own mirrored node,
// so this scene covers both the loader-level flip and an asset-level one. The new parent has a
// non-identity rotation + translation + scale so a broken decomposition shows up as a mirror
// AND as a misplacement. Static scene.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    loadGltf,
    loadEnvironment,
    attachControl,
    registerScene,
    createTransformNode,
    setParent,
} from "babylon-lite";
import type { ArcRotateCamera, SceneNode } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Node_NegativeScale/Node_NegativeScale_01.gltf";

/** Yaw of the new parent, as a quaternion (0, sin(a/2), 0, cos(a/2)). */
const YAW = Math.PI / 7;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 4, Math.sqrt(800), { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const container = await loadGltf(engine, MODEL_URL);
    const gltfRoot = container.entities[0] as SceneNode;

    // The forum repro: wrap the loaded hierarchy in a user-created transform node.
    const newRoot = createTransformNode("newRoot", 0, 2, -3, 0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2), 1.2, 1.2, 1.2);
    setParent(gltfRoot, newRoot);

    addToScene(scene, container);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
