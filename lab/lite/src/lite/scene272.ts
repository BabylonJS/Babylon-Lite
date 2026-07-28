// Scene 272 — Introducing a new material family at runtime.
//
// Regression scene for the forum repro at
// https://forum.babylonjs.com/t/addtoscene-removefromscene-and-what-seems-to-be-a-bit-of-inconsistency/63783
// (playground O5GYE3): a scene is registered containing only StandardMaterial meshes, and a PBR mesh is
// then added with `addToScene` from inside `onBeforeRender`.
//
// The trigger is NOT "adding after registerScene" and is not PBR-specific — it is that no mesh of that
// material group existed at `registerScene` time. `addToScene` creates the group but pushes no deferred
// builder once the scene is built (deferred builders only run at boot), so the group has no rebuild
// function, and the material-swap drain used to skip such meshes and then clear the queue: the mesh got
// no renderable at all, with no error and no warning. It is now handed to the runtime build path, which
// knows how to materialize a never-built group.
//
// The BJS reference adds the same PBR box at the same point in its render loop, so the golden image
// contains it; before the fix the Lite frame is simply missing the box.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";

/** Frame on which the first-ever PBR mesh joins the already-built scene. */
const ADD_FRAME = 20;
/** Frames rendered after the add before the scene is declared ready. The runtime build is
 *  asynchronous — a dynamic module import plus shader compilation and a full group build — so this
 *  is deliberately generous rather than tuned. */
const SETTLE_FRAMES = 150;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    engine._device.addEventListener("uncapturederror", (event) => {
        const message = (event as GPUUncapturedErrorEvent).error.message;
        canvas.dataset.gpuError = message;
        console.error(message);
    });

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    scene.fixedDeltaMs = 16;

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 6, { x: 0, y: 0.9, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 50;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Everything present at registerScene time is StandardMaterial — so the PBR group below is
    // genuinely brand new when it is created at runtime.
    const box = createBox(engine, 1);
    box.position.set(-1.2, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    boxMat.specularColor = [0, 0, 0];
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    groundMat.specularColor = [0, 0, 0];
    ground.material = groundMat;
    addToScene(scene, ground);

    // Built up front but deliberately NOT added until the scene is running.
    const pbrBox = createBox(engine, 1);
    pbrBox.position.set(1.2, 0.5, 0);
    pbrBox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.2, 0.6, 1.0, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 1.0, 1.0, 1),
        metallicFactor: 0.1,
        roughnessFactor: 0.4,
        directIntensity: 1.0,
        environmentIntensity: 0.0,
    });

    let frame = 0;
    let added = false;
    onBeforeRender(scene, () => {
        frame++;
        if (!added && frame >= ADD_FRAME) {
            added = true;
            addToScene(scene, pbrBox);
            canvas.dataset.added = "true";
        }
        if (added && frame >= ADD_FRAME + SETTLE_FRAMES) {
            canvas.dataset.drawCalls = String(engine.drawCallCount);
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.loaded = "true";
    canvas.dataset.initMs = String(performance.now() - __initStart);
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
