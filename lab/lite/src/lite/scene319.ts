// Upstream "Textured - Area Lights - Standard Material", Playground #T7FXR8#103.
// Diagnostic AxesViewer arrows and ineffective Standard metallic/albedo fields are omitted.
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
    loadTexture2D,
    processAreaLightTexture,
    registerScene,
    setStandardEmissiveTexture,
    startEngine,
} from "babylon-lite";

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

    const panel = createBox(engine, { width: 6, height: 6, depth: 0.01 });
    panel.name = "boxlight1";
    panel.position.set(2, 10, 0);
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
    const panelMaterial = createStandardMaterial();
    panelMaterial.disableLighting = true;
    panelMaterial.emissiveColor = [1, 1, 1];
    panel.material = panelMaterial;
    addToScene(scene, panel);

    const light = createRectAreaLight([0, 0, 0], 6, 6, 1);
    light.name = "lightlight1";
    light.parent = panel;
    light.diffuse = [1, 1, 1];
    light.specular = [1, 1, 1];
    const source = await loadTexture2D(engine, "https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/Cyberpunk_AI_Square.png", {
        srgb: false,
    });
    light.emissionTexture = await processAreaLightTexture(engine, source);
    panelMaterial.diffuseTexture = source;
    setStandardEmissiveTexture(panelMaterial, source);
    addToScene(scene, light);
    canvas.dataset.emissionReady = "true";

    const material = createStandardMaterial();
    material.roughness = 0.2;
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.name = "sphere";
    sphere.position.y = 1;
    sphere.material = material;
    addToScene(scene, sphere);
    const ground = createGround(engine, { width: 120, height: 120 });
    ground.name = "ground";
    ground.material = material;
    addToScene(scene, ground);
    const material2 = createStandardMaterial();
    material2.roughness = 0.9;
    const sphere2 = createSphere(engine, { diameter: 3, segments: 32 });
    sphere2.name = "sphere2";
    sphere2.position.set(-3, 3, 0);
    sphere2.material = material2;
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
