/**
 * Grid Studio — an infinite reference grid (the built-in grid material) under a
 * trio of PBR shapes, lit by an image-based environment. The kind of clean,
 * neutral staging ground you'd use to inspect a material or model. Shows off
 * `createGridMaterial`, PBR metalness/roughness, and IBL together. Public assets
 * only.
 */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGridMaterial,
    createGround,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    createTorusKnot,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.03, g: 0.04, b: 0.06, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2.6, 1.15, 9, { x: 0, y: 0.6, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    // IBL for the PBR shapes; no skybox/ground so the grid stays the backdrop.
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    // Infinite grid floor, Babylon-brand teal lines.
    const ground = createGround(engine, { width: 60, height: 60 });
    ground.material = createGridMaterial({
        mainColor: [0.05, 0.06, 0.08],
        lineColor: [0.22, 0.55, 0.6],
        gridRatio: 0.5,
        majorUnitFrequency: 8,
    });
    addToScene(scene, ground);

    // A polished metal torus knot centre stage.
    const knot = createTorusKnot(engine, { radius: 0.8, tube: 0.26, radialSegments: 128, tubularSegments: 32 });
    knot.position.set(0, 0.9, 0);
    knot.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.95, 0.78, 0.4),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.2, 1.0), // glossy metal
        environmentIntensity: 1.0,
    });
    addToScene(scene, knot);

    // A matte dielectric sphere and a glossy box flanking it.
    const sphere = createSphere(engine, { diameter: 1.1, segments: 32 });
    sphere.position.set(-2.4, 0.55, 0.4);
    sphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.85, 0.27, 0.27),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.55, 0.0),
        environmentIntensity: 1.0,
    });
    addToScene(scene, sphere);

    const box = createBox(engine, 1.1);
    box.position.set(2.4, 0.55, -0.4);
    box.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.3, 0.5, 0.85),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.15, 0.0),
        environmentIntensity: 1.0,
    });
    addToScene(scene, box);

    // Slowly turn the knot so its reflections shift.
    onBeforeRender(scene, (deltaMs) => {
        knot.rotation.y += (deltaMs / 1000) * 0.5;
    });

    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((err) => console.error(err));
