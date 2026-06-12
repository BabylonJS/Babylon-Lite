// Scene 223 — Camera + Light Gizmos (Babylon Lite)
//
// A ground plane with one gizmo for every supported light type plus a
// CameraGizmo:
//   • HemisphericLight  → hemisphere dome + 3-level lines   (far left)
//   • PointLight        → sphere + 5-level star lines       (left)
//   • SpotLight         → sphere + wide hemisphere + lines  (right)
//   • DirectionalLight  → sphere + 3 parallel arrows        (far right)
//   • A subject FreeCamera visualised by a CameraGizmo      (back centre)
//
// All gizmos render through a utility-layer overlay so they always appear on
// top of the ground.  Pure display scene — no scripted interaction.
import {
    addToScene,
    attachCameraGizmoToCamera,
    attachControl,
    attachLightGizmoToLight,
    createArcRotateCamera,
    createCameraGizmo,
    createDirectionalLight,
    createEngine,
    createFreeCamera,
    createGround,
    createHemisphericLight,
    createLightGizmo,
    createPointLight,
    createSceneContext,
    createSpotLight,
    createStandardMaterial,
    createUtilityLayer,
    onBeforeRender,
    registerScene,
    registerUtilityLayer,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const mainCamera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 18, { x: 0, y: 1.5, z: 0 });
    mainCamera.nearPlane = 0.1;
    mainCamera.farPlane = 100;
    scene.camera = mainCamera;
    attachControl(mainCamera, canvas, scene);

    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.55];
    const ground = createGround(engine, { width: 20, height: 14 });
    ground.material = groundMat;
    addToScene(scene, ground);

    // ── One light of each supported type, spread along X at y = 2 ──
    const Y = 2;

    const hemiLight = createHemisphericLight([0, 1, 0]);
    hemiLight.intensity = 0.7;
    addToScene(scene, hemiLight);

    const pointLight = createPointLight([-2.5, Y, 0]);
    pointLight.diffuse = [1, 0.85, 0.4];
    pointLight.intensity = 0.3;
    addToScene(scene, pointLight);

    const spotLight = createSpotLight([2.5, Y, 0], [0, -1, 0.0001], Math.PI / 3, 2, 0.4);
    spotLight.diffuse = [0.5, 0.7, 1];
    addToScene(scene, spotLight);

    const dirLight = createDirectionalLight([0.25, -1, 0.25], 0.3);
    dirLight.position.set(7, Y, 0);
    addToScene(scene, dirLight);

    // Subject camera (back centre) — visualised by the CameraGizmo.
    const subjectCamera = createFreeCamera({ x: 0, y: 3, z: -5 }, { x: 0, y: 0.5, z: 0 });
    subjectCamera.nearPlane = 1;
    subjectCamera.farPlane = 10;
    await registerScene(scene);

    const utilityLayer = createUtilityLayer(engine, scene);

    // Camera gizmo.
    const cameraGizmo = createCameraGizmo(engine, utilityLayer);
    attachCameraGizmoToCamera(cameraGizmo, subjectCamera);

    // One gizmo per light type.  Hemispheric has no position, so place its
    // gizmo root manually; the others follow their light's position.
    const hemiGizmo = createLightGizmo(engine, utilityLayer);
    attachLightGizmoToLight(hemiGizmo, hemiLight);
    hemiGizmo.root.position.set(-7, Y, 0);

    const pointGizmo = createLightGizmo(engine, utilityLayer);
    attachLightGizmoToLight(pointGizmo, pointLight);

    const spotGizmo = createLightGizmo(engine, utilityLayer);
    attachLightGizmoToLight(spotGizmo, spotLight);

    const dirGizmo = createLightGizmo(engine, utilityLayer);
    attachLightGizmoToLight(dirGizmo, dirLight);

    await registerUtilityLayer(utilityLayer);

    (window as unknown as Record<string, unknown>).__scene223 = {
        mainCamera,
        subjectCamera,
        hemiLight,
        pointLight,
        spotLight,
        dirLight,
        cameraGizmo,
        hemiGizmo,
        pointGizmo,
        spotGizmo,
        dirGizmo,
    };

    let frame = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        frame++;
        if (frame === 3) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await startEngine(engine);
}

main().catch(console.error);
