// Complement to upstream fixtures: parent scale, light-local rotation, mixed
// lights, one-sided emission, and PR #16723 metallic/albedo regression.
import {
    addToScene,
    attachFreeControl,
    createBox,
    createEngine,
    createFreeCamera,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createPointLight,
    createRectAreaLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTransformNode,
    enableRectAreaLights,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    const camera = createFreeCamera({ x: -9, y: 8, z: -15 }, { x: 0, y: 1.5, z: 1 });
    camera.nearPlane = 1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    const parent = createTransformNode("scaled-emitter", 0, 4, 5);
    parent.rotationQuaternion.set(Math.sin(-0.55 / 2), 0, 0, Math.cos(-0.55 / 2));
    parent.scaling.set(1.5, 0.75, 1.2);
    addToScene(scene, parent);

    const light = createRectAreaLight([0, 0, 0], 2.5, 2, 3);
    light.name = "front-emitter";
    light.parent = parent;
    light.rotationQuaternion.set(0, Math.sin(0.2 / 2), 0, Math.cos(0.2 / 2));
    light.diffuse = [1, 1, 1];
    light.specular = [1, 1, 1];
    addToScene(scene, light);

    const panel = createBox(engine, { width: 2.5, height: 2, depth: 0.01 });
    panel.name = "front-panel";
    panel.parent = light;
    const panelMaterial = createStandardMaterial();
    panelMaterial.disableLighting = true;
    panelMaterial.emissiveColor = [1, 1, 1];
    panel.material = panelMaterial;
    addToScene(scene, panel);

    // All receivers are behind this unrotated light's emitting -Z face.
    // A two-sided bug produces conspicuous magenta illumination.
    const back = createRectAreaLight([0, 3, -2], 3, 2, 8);
    back.name = "back-facing-magenta";
    back.diffuse = [1, 0, 1];
    back.specular = [1, 0, 1];
    addToScene(scene, back);

    const point = createPointLight([-5, 5, -1], 0.35);
    point.diffuse = [0.1, 0.3, 1];
    point.specular = [0.1, 0.3, 1];
    addToScene(scene, point);
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.08));

    for (let i = 0; i < 4; i++) {
        const tinted = i % 2 === 1;
        const sphere = createSphere(engine, { diameter: 1.7, segments: 32 });
        sphere.name = `pbr-${i < 2 ? "dielectric" : "metal"}-${tinted ? "tinted" : "white"}`;
        sphere.position.set(-3.3 + i * 2.2, 0.85, 0);
        sphere.material = createPbrMaterial({
            baseColorFactor: tinted ? [0.8, 0.12, 0.04, 1] : [1, 1, 1, 1],
            roughnessFactor: 0.25,
            metallicFactor: i < 2 ? 0 : 1,
        });
        addToScene(scene, sphere);
    }

    for (let i = 0; i < 2; i++) {
        const material = createStandardMaterial();
        material.diffuseColor = i === 0 ? [0.1, 0.6, 0.9] : [0.9, 0.45, 0.08];
        material.specularPower = i === 0 ? 16 : 128;
        const sphere = createSphere(engine, { diameter: 1.7, segments: 32 });
        sphere.name = `standard-${i}`;
        sphere.position.set(i === 0 ? -1.4 : 1.4, 0.85, 3);
        sphere.material = material;
        addToScene(scene, sphere);
    }

    const ground = createGround(engine, { width: 14, height: 8 });
    ground.name = "ground";
    ground.position.z = 3;
    const groundMaterial = createStandardMaterial();
    groundMaterial.diffuseColor = [0.18, 0.18, 0.18];
    groundMaterial.specularColor = [0, 0, 0];
    ground.material = groundMaterial;
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
