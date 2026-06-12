// Scene 18: Spotlight Hard Shadows (PCF) — FreeCamera + SpotLight + PCF Shadow Generator
// Demonstrates new FreeCamera type and PCF shadow mapping for spot lights.

import { addToScene, startEngine, createEngine, createSceneContext, createFreeCamera, createSpotLight, createGround, createBox, createStandardMaterial, createPcfSpotlightShadowGenerator, setShadowTaskCasterMeshes, loadTexture2D, attachFreeControl, registerSceneWithShadowSupport } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // FreeCamera at (0, 10, -20) looking at origin
    const cam = createFreeCamera({ x: 0, y: 10, z: -20 }, { x: 0, y: 0, z: 0 });
    cam.nearPlane = 1;
    cam.farPlane = 10000;
    scene.camera = cam;
    attachFreeControl(cam, canvas, scene);

    // Ground — 24×60 with diffuse texture, emissive glow, no specular
    const ground = createGround(engine, { width: 24, height: 60 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseTexture = await loadTexture2D(engine, "https://playground.babylonjs.com/textures/ground.jpg");
    groundMat.specularColor = [0, 0, 0];
    groundMat.emissiveColor = [0.2, 0.2, 0.2];
    ground.material = groundMat;
    ground.receiveShadows = true;
    addToScene(scene, ground);

    // Box — size 5 at (0, 5, 0), red diffuse, dark red specular
    const box = createBox(engine, 5);
    box.position.set(0, 5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [1.0, 0, 0];
    boxMat.specularColor = [0.5, 0, 0];
    box.material = boxMat;
    addToScene(scene, box);

    // SpotLight at (0, 20, -10) pointing (0, -1, 0.3), angle=1.2, exponent=24
    const light = createSpotLight([0, 20, -10], [0, -1, 0.3], 1.2, 24);
    addToScene(scene, light);

    // PCF Shadow Generator — box casts shadow onto ground
    light.shadowGenerator = createPcfSpotlightShadowGenerator(engine, light, {
        mapSize: 512,
        near: cam.nearPlane,
        far: cam.farPlane,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, [box]);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
