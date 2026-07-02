/**
 * Camera FOV cache invalidation — a repro for issue #271.
 *
 * The camera never moves, so its `worldMatrixVersion` stays constant for the
 * whole run. Each frame we only mutate the public projection field
 * `camera.fov` (and periodically `nearPlane` / `farPlane`). If the projection
 * cache were still keyed on `worldMatrixVersion` (the pre-fix behaviour) the
 * rendered projection would be frozen at the initial FOV and nothing would
 * appear to change. With the fix, `getProjectionMatrix` keys on the actual
 * projection inputs, so the ring of cubes should visibly "breathe" (zoom in
 * and out) purely from the per-frame FOV change.
 */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createEngine,
    onBeforeRender,
    registerScene,
    startEngine,
    type Mesh,
} from "@babylonjs/lite";

const COUNT = 8;
const RADIUS = 3.5;
const BASE_FOV = 0.8;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };

    // Static camera: we deliberately never change alpha/beta/radius/target,
    // so worldMatrixVersion is fixed and only fov/near/far vary at runtime.
    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 12, { x: 0, y: 0, z: 0 });
    camera.fov = BASE_FOV;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([-0.5, -1, -0.4], 1.2));

    const cubes: Mesh[] = [];
    for (let i = 0; i < COUNT; i++) {
        const cube = createBox(engine, 1);
        const mat = createStandardMaterial();
        const hue = i / COUNT;
        mat.diffuseColor = [0.5 + 0.5 * Math.sin(hue * 6.28), 0.5 + 0.5 * Math.sin(hue * 6.28 + 2.1), 0.5 + 0.5 * Math.sin(hue * 6.28 + 4.2)];
        mat.specularColor = [0.3, 0.3, 0.3];
        cube.material = mat;
        const angle = (i / COUNT) * Math.PI * 2;
        cube.position.set(Math.cos(angle) * RADIUS, 0, Math.sin(angle) * RADIUS);
        addToScene(scene, cube);
        cubes.push(cube);
    }

    let t = 0;
    onBeforeRender(scene, (deltaMs) => {
        t += deltaMs / 1000;
        // Pulse the field of view every frame WITHOUT moving the camera.
        camera.fov = BASE_FOV + Math.sin(t * 1.5) * 0.35;
        // Also nudge the clip planes periodically to exercise near/far invalidation.
        camera.nearPlane = 0.1 + (Math.sin(t * 0.7) * 0.5 + 0.5) * 0.4;
        camera.farPlane = 100;
    });

    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((err) => console.error(err));
