// Upstream visualization areaLightsStandardMaterial: Playground #T7FXR8#67.
// Diagnostic AxesViewer arrows are omitted in both engines; lighting is unchanged.
import {
    addToScene,
    attachFreeControl,
    createBox,
    createEngine,
    createFreeCamera,
    createGround,
    createRectAreaLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    enableRectAreaLights,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, SceneContext } from "babylon-lite";

function addEmitter(
    scene: SceneContext,
    engine: EngineContext,
    position: [number, number, number],
    pitch: number,
    yaw: number,
    color: [number, number, number],
    name: string
): void {
    const panel = createBox(engine, { width: 6, height: 6, depth: 0.01 });
    panel.name = `box${name}`;
    panel.position.set(...position);
    // BJS Euler rotation is yaw-pitch-roll, not Lite's Euler XYZ proxy.
    const sx = Math.sin(pitch / 2);
    const cx = Math.cos(pitch / 2);
    const sy = Math.sin(yaw / 2);
    const cy = Math.cos(yaw / 2);
    panel.rotationQuaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx);
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.emissiveColor = color;
    panel.material = material;
    addToScene(scene, panel);

    const light = createRectAreaLight([0, 0, 0], 6, 6, 0.7);
    light.name = `light${name}`;
    light.parent = panel;
    light.diffuse = color;
    light.specular = color;
    addToScene(scene, light);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createFreeCamera({ x: -20, y: 15, z: -15 }, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    addEmitter(scene, engine, [2, 3, -1], 5.976007358828584, 1.5969762655748114, [1, 1, 1], "light1");
    addEmitter(scene, engine, [-3, 3, 10], 5.681046715241543, 0, [1, 0, 0], "light2");
    addEmitter(scene, engine, [-10, 3, -1], 5.681046715241543, -1.5969762655748114, [0, 1, 0], "light3");

    // Standard roughness controls the LTC lookup; metallic is ignored by BJS.
    const blue = createStandardMaterial();
    blue.roughness = 0.1;
    blue.diffuseColor = [0, 0, 1];
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.name = "sphere";
    sphere.position.y = 1;
    sphere.material = blue;
    addToScene(scene, sphere);

    const ground = createGround(engine, { width: 120, height: 120 });
    ground.name = "ground";
    const groundMaterial = createStandardMaterial();
    groundMaterial.roughness = 0.2;
    ground.material = groundMaterial;
    addToScene(scene, ground);

    const red = createStandardMaterial();
    red.roughness = 0.9;
    red.diffuseColor = [1, 0, 0];
    const sphere2 = createSphere(engine, { diameter: 3, segments: 32 });
    sphere2.name = "sphere2";
    sphere2.position.set(-3, 3, 0);
    sphere2.material = red;
    addToScene(scene, sphere2);

    await enableRectAreaLights(scene);
    canvas.dataset.ltcReady = "true";
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
