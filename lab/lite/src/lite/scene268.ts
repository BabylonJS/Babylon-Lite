// Scene 268 — Orthographic Camera Projection
//
// Two rows of identical boxes recede along +Z. Under a perspective projection the far
// boxes would shrink and the rows would converge; the orthographic projection installed by
// `enableOrthographicCamera` keeps every box the same on-screen size and the rows parallel.
//
// The view volume is described by `halfHeight` only, so the horizontal extent is derived
// from the render-target aspect ratio each frame (no squashing on resize).

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    enableOrthographicCamera,
    registerScene,
    startEngine,
} from "babylon-lite";

const ORTHO_HALF_HEIGHT = 6;
const ROW_X = [-4, 4];
const DEPTHS = [-7, -3.5, 0, 3.5, 7];
const COLORS: [number, number, number][] = [
    [0.85, 0.25, 0.25],
    [0.9, 0.6, 0.2],
    [0.35, 0.75, 0.4],
    [0.25, 0.55, 0.9],
    [0.65, 0.35, 0.85],
];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.06, g: 0.07, b: 0.1, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2 + 0.4, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    enableOrthographicCamera(camera, { halfHeight: ORTHO_HALF_HEIGHT });
    scene.camera = camera;

    const light = createHemisphericLight([0, 1, 0]);
    addToScene(scene, light);

    for (const x of ROW_X) {
        for (let i = 0; i < DEPTHS.length; i++) {
            const box = createBox(engine, 2);
            box.position.set(x, 0, DEPTHS[i]!);
            const material = createStandardMaterial();
            material.diffuseColor = COLORS[i]!;
            material.specularColor = [0, 0, 0];
            box.material = material;
            addToScene(scene, box);
        }
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
