// Scene 141: Scene 65 ESM shadow setup plus Standard and PBR caster spheres.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createGround,
    createDirectionalLight,
    createEsmDirectionalShadowGenerator,
    createStandardMaterial,
    createPbrMaterial,
    createSolidTexture2D,
    attachControl,
    registerSceneWithShadowSupport,
    parseNodeMaterialFromSnippet,
    setShadowTaskCasterMeshes,
} from "babylon-lite";
import { SCENE65_NME_JSON } from "../shared/scene65-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2.3, Math.PI / 2.5, 8, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    const light = createDirectionalLight([-1, -2, -1], 1);
    light.position.set(5, 10, 5);
    addToScene(scene, light);

    const nmeSphere = createSphere(engine);
    nmeSphere.position.set(0, 1.5, 0);

    const stdSphere = createSphere(engine);
    stdSphere.position.set(-2, 1.5, 0);
    const stdMaterial = createStandardMaterial();
    stdMaterial.diffuseColor = [0.95, 0.28, 0.18];
    stdMaterial.specularPower = 32;
    stdSphere.material = stdMaterial;

    const pbrSphere = createSphere(engine);
    pbrSphere.position.set(2, 1.5, 0);
    pbrSphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.15, 0.55, 1.0, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.45, 0.2, 1),
        usePhysicalLightFalloff: false,
    });

    const ground = createGround(engine, { width: 10, height: 10, subdivisions: 2 });
    ground.receiveShadows = true;

    light.shadowGenerator = createEsmDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        depthScale: 50,
        bias: 0.00005,
        blurKernel: 64,
        blurScale: 2,
        darkness: 0,
        frustumEdgeFalloff: 0,
        orthoMinZ: scene.camera.nearPlane,
        orthoMaxZ: scene.camera.farPlane,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, [nmeSphere, stdSphere, pbrSphere]);

    const nmeMaterial = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE65_NME_JSON,
        shadowGenerators: [light.shadowGenerator],
    });
    nmeSphere.material = nmeMaterial;
    ground.material = nmeMaterial;
    addToScene(scene, nmeSphere);
    addToScene(scene, stdSphere);
    addToScene(scene, pbrSphere);
    addToScene(scene, ground);

    await registerSceneWithShadowSupport(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
