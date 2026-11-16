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
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    const camera = createFreeCamera({ x: -20, y: 15, z: -15 }, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    const source = await loadTexture2D(engine, "https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/Cyberpunk_AI_Square.png", {
        srgb: false,
    });
    const light = createRectAreaLight([2, 10, 0], 12, 12, 1);
    const pitch = 5.976007358828584;
    const yaw = 1.5969762655748114;
    light.rotationQuaternion.set(
        Math.cos(yaw / 2) * Math.sin(pitch / 2),
        Math.sin(yaw / 2) * Math.cos(pitch / 2),
        -Math.sin(yaw / 2) * Math.sin(pitch / 2),
        Math.cos(yaw / 2) * Math.cos(pitch / 2)
    );
    // Assign the processed map to the light, not the original image.
    light.emissionTexture = await processAreaLightTexture(engine, source);
    addToScene(scene, light);

    // Optional visible panel: illumination comes from the light above.
    const panel = createBox(engine, { width: 12, height: 12, depth: 0.02 });
    panel.parent = light;
    const panelMaterial = createStandardMaterial();
    panelMaterial.disableLighting = true;
    panelMaterial.emissiveColor = [1, 1, 1];
    panelMaterial.diffuseTexture = source;
    setStandardEmissiveTexture(panelMaterial, source);
    panel.material = panelMaterial;
    addToScene(scene, panel);

    const receiver = createStandardMaterial();
    receiver.roughness = 0.2;
    const ground = createGround(engine, { width: 120, height: 120 });
    ground.material = receiver;
    addToScene(scene, ground);
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.position.y = 1;
    sphere.material = receiver;
    addToScene(scene, sphere);

    await enableRectAreaLights(scene);
    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((error) => console.error(error));
