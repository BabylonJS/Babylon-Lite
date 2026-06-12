// Scene 216: PBR Fog — a receding row of PBR boxes fading into linear fog.
// Validates PBR fog parity with Babylon.js: fog is mixed into the linear HDR colour
// BEFORE the tonemap / image-processing chain, using the PBR-specific linearised fog
// factor (toLinearSpace(fog) = pow(fog, 2.2)). The background colour matches the fog
// colour, so distant boxes fade cleanly into the haze.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, createBox, createPbrMaterial, createSolidTexture2D, registerScene, setFog } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.7, g: 0.75, b: 0.82, a: 1 };

    scene.camera = createArcRotateCamera(0.4, 1.2, 20, { x: -10, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Linear fog (mode 3) fades the receding row into the matching background colour.
    // setFog must be called before registerScene so the PBR shader is built with fog.
    setFog(scene, { mode: 3, density: 0, start: 12, end: 60, color: [0.7, 0.75, 0.82] });

    // Gold PBR (baseColor=gold, metallic=0, roughness=1), one material shared by all boxes.
    const baseColorTex = createSolidTexture2D(engine, 1.0, 0.766, 0.336);
    const ormTex = createSolidTexture2D(engine, 1.0, 1.0, 0.0); // occ=1, rough=1, metal=0
    const mat = createPbrMaterial({ baseColorTexture: baseColorTex, ormTexture: ormTex });

    for (let i = 0; i < 10; i++) {
        const box = createBox(engine);
        box.position.set(-i * 5, 0, 0);
        box.material = mat;
        addToScene(scene, box);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
