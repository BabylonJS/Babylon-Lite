import { addToScene, attachControl, createArcRotateCamera, createDirectionalLight, createEngine, createHemisphericLight, createSceneContext, enableBoneControl, getBoneByName, loadGltf, registerScene, setBoneVisible, startEngine } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const XBOT_URL = "https://playground.babylonjs.com/scenes/Xbot.glb";
const HIDDEN_BONE = "mixamorig:LeftArm";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 4, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([0, -0.5, -1], 0.8));

    // Opt-in bone control BEFORE loading so the skeleton handles are built.
    enableBoneControl();

    const xbot = await loadGltf(engine, XBOT_URL);
    for (const entity of xbot.entities) {
        addToScene(scene, entity);
    }

    // Static (no animation): hide the whole left arm by collapsing its bone
    // sub-tree to zero scale — the Babylon "hide a node of a skinned model" trick.
    const skel = xbot.skeletons?.[0];
    const arm = skel ? getBoneByName(skel, HIDDEN_BONE) : undefined;
    if (skel && arm) {
        setBoneVisible(skel, arm, false);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
