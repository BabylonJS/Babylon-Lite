// Scene 270: scene clip plane on built-in PBR and Standard materials.
// Regression coverage for the forum report that `setClipPlane` was honored only
// by Node Material. A single scene clip plane (y > 0 discarded) must slice both
// the Standard-material sphere and the PBR-material sphere, matching Babylon.js
// where `scene.clipPlane` clips every material family automatically.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    createStandardMaterial,
    registerScene,
    setClipPlane,
    startEngine,
} from "babylon-lite";

// Lite `setClipPlane(scene, [a,b,c,d])` == BJS `new Plane(a,b,c,d)`; discards
// fragments where dot(vec4(worldPos,1), plane) > 0, i.e. the upper hemisphere.
const CLIP_PLANE: readonly [number, number, number, number] = [0, 1, 0, 0];

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.03, g: 0.035, b: 0.05, a: 1 };
    setClipPlane(scene, CLIP_PLANE);

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.6, 9, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const stdSphere = createSphere(engine, { segments: 32, diameter: 2.4 });
    stdSphere.position.set(-2.2, 0, 0);
    const stdMat = createStandardMaterial();
    stdMat.diffuseColor = [0.95, 0.25, 0.15];
    stdMat.specularColor = [0.4, 0.4, 0.4];
    stdMat.specularPower = 48;
    stdSphere.material = stdMat;

    const pbrSphere = createSphere(engine, { segments: 32, diameter: 2.4 });
    pbrSphere.position.set(2.2, 0, 0);
    pbrSphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.15, 0.55, 1.0, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 1.0, 1.0, 1),
        metallicFactor: 0.2,
        roughnessFactor: 0.4,
        directIntensity: 1.0,
        environmentIntensity: 0.0,
    });

    const hemi = createHemisphericLight([0, 1, 0], 0.7);
    hemi.diffuseColor = [1.0, 1.0, 1.0];
    hemi.groundColor = [0.1, 0.1, 0.12];
    const dir = createDirectionalLight([-0.4, -1, -0.3], 0.8);
    dir.position.set(4, 8, 5);
    dir.diffuse = [1.0, 0.95, 0.85];

    addToScene(scene, hemi);
    addToScene(scene, dir);
    addToScene(scene, stdSphere);
    addToScene(scene, pbrSphere);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
