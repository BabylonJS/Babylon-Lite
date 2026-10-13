// Upstream "Textured - Area Lights - PBR", Playground #T7FXR8#102.
// Only diagnostic AxesViewer arrows are omitted.
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createPbrMaterial,
    createRectAreaLight,
    createSceneContext,
    createStandardMaterial,
    enableRectAreaLights,
    loadTexture2D,
    processAreaLightTexture,
    registerScene,
    setStandardEmissiveTexture,
    startEngine,
} from "babylon-lite";
import type { EngineContext, SceneContext } from "babylon-lite";

async function addEmitter(scene: SceneContext, engine: EngineContext, position: [number, number, number], name: string, asset: string): Promise<void> {
    const panel = createBox(engine, { width: 6, height: 6, depth: 0.01 });
    panel.name = `box${name}`;
    panel.position.set(...position);
    panel.scaling.set(2, 2, 2);
    // Match BJS yaw-pitch-roll rather than Lite's Euler XYZ proxy.
    const pitch = 5.976007358828584;
    const yaw = 1.5969762655748114;
    panel.rotationQuaternion.set(
        Math.cos(yaw / 2) * Math.sin(pitch / 2),
        Math.sin(yaw / 2) * Math.cos(pitch / 2),
        -Math.sin(yaw / 2) * Math.sin(pitch / 2),
        Math.cos(yaw / 2) * Math.cos(pitch / 2)
    );
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.emissiveColor = [1, 1, 1];
    panel.material = material;
    addToScene(scene, panel);

    const light = createRectAreaLight([0, 0, 0], 6, 6, 2);
    light.name = `light${name}`;
    light.parent = panel;
    light.diffuse = [1, 1, 1];
    light.specular = [1, 1, 1];
    const source = await loadTexture2D(engine, `https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/${asset}`, { srgb: false });
    light.emissionTexture = await processAreaLightTexture(engine, source);
    material.diffuseTexture = source;
    setStandardEmissiveTexture(material, source);
    addToScene(scene, light);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    const camera = createArcRotateCamera(3.78, 1.15, 93.92, { x: 15, y: 10, z: -15 });
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    await addEmitter(scene, engine, [10, 10, 0], "light1", "White.png");
    await addEmitter(scene, engine, [15, 10, -15], "light2", "Cyberpunk3_AI_Square.png");
    await addEmitter(scene, engine, [10, 10, -30], "light3", "Grey.png");
    canvas.dataset.emissionReady = "true";

    const material = createPbrMaterial({ baseColorFactor: [0.5, 0.5, 0.5, 1], roughnessFactor: 0.1, metallicFactor: 0 });
    const ground = createGround(engine, { width: 120, height: 120 });
    ground.name = "ground";
    ground.material = material;
    addToScene(scene, ground);

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
