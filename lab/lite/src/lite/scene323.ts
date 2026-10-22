// Scene 323: glTF export, KHR_lights_punctual. Babylon.js visualization test "GLTF Serializer KHR punctual light,
// left-handed" (playground #FLXW8B#27, `roundtrip = true; useRightHandedSystem = false`). A directional, a point and a
// spot light (glTF falloff) light a PBR ground. Only the lights are exported with exportSceneAsGlb and reloaded with
// loadGltf; camera, ground and material stay as built. The right-handed test is not ported (Lite has no right-handed scenes).
import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createGround,
    createPbrMaterial,
    createPointLight,
    createSceneContext,
    createSpotLight,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 4, 8, { x: 0, y: 0, z: 0 });

    const ground = createGround(engine, { width: 5, height: 5 });
    ground.material = createPbrMaterial({ roughnessFactor: 0.66 });
    addToScene(scene, ground);

    // Lights. Babylon.js FALLOFF_GLTF is Lite's default physical falloff (PBR `usePhysicalLightFalloff`).
    // The snippet's `shouldExportNode` keeps only lights; Lite's exporter has no filter, so the lights are
    // exported from a scene of their own and only the reloaded lights join the render scene.
    const lightScene = createSceneContext(engine);
    const directional = createDirectionalLight([-1, -1, -1], 0.2);
    directional.name = "directional";
    const point = createPointLight([2, 2, 2]);
    point.name = "point";
    // Angle 30 (radians, as in the snippet), exponent 2.
    const spot = createSpotLight([-2, 2, -2], [2, -2, 2], 30, 2);
    spot.name = "spot";
    addToScene(lightScene, directional);
    addToScene(lightScene, point);
    addToScene(lightScene, spot);

    addToScene(scene, await loadGltf(engine, await exportSceneAsGlb(lightScene)));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
