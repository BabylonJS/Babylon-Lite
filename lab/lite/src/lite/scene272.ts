// Scene 272 — Runtime mesh swap with a shared material texture.
//
// Regression scene for the forum repro at
// https://forum.babylonjs.com/t/addtoscene-removefromscene-and-what-seems-to-be-a-bit-of-inconsistency/63783
// (playground UA94OF): from inside `onBeforeRender` — i.e. in the MIDDLE of a frame — the source box is
// removed and a clone of it is added. The clone shares the source's material, and therefore its
// ref-counted diffuse texture.
//
// `removeFromScene` used to run its GPU teardown synchronously, so the shared texture's ref count hit
// zero and the GPUTexture was destroyed right there. The clone's renderable, built later in the SAME
// frame by the material-swap drain, then re-acquired a texture whose GPU object was already dead:
// "Destroyed texture [Texture (unlabeled 1x1 px, TextureFormat::RGBA8Unorm)] used in a submit", and a
// black canvas. Teardown is now retired until after the frame submits, which also restores
// make-before-break: the rebuild re-acquires the texture before the deferred release lands.
//
// The BJS reference performs the same dispose/clone dance, so the golden image is the post-swap state:
// ground + the clone box at the raised position, with the source box gone.

import {
    addToScene,
    attachControl,
    cloneTransformNode,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";

/** Frame on which the source mesh is removed and the clone added, from inside the render loop. */
const SWAP_FRAME = 20;
/** Frames rendered after the swap before the scene is declared ready, so a stale/destroyed
 *  resource has ample opportunity to reach a submit and surface as a validation error. */
const SETTLE_FRAMES = 30;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    // Surface WebGPU validation errors to the parity spec. The regression's signature is
    // "Destroyed texture ... used in a submit", which the image diff alone would only catch
    // indirectly (via the resulting black frame).
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

    // The box's material owns a ref-counted 1x1 texture. White, so the visible colour comes from
    // diffuseColor alone and the reference cannot drift on texture colour-space handling — the
    // texture is here for its LIFETIME, which is what this scene regresses.
    const box = createBox(engine, 1);
    box.position.set(0, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    boxMat.specularColor = [0, 0, 0];
    boxMat.diffuseTexture = createSolidTexture2D(engine, 1, 1, 1, 1);
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    groundMat.specularColor = [0, 0, 0];
    ground.material = groundMat;
    addToScene(scene, ground);

    // Shares `_gpu` (ref-counted geometry) AND the material object — hence the same texture.
    const clone = cloneTransformNode(box);
    clone.position.set(0, 1.75, 0);

    let frame = 0;
    let swapped = false;
    onBeforeRender(scene, () => {
        frame++;
        if (!swapped && frame >= SWAP_FRAME) {
            swapped = true;
            removeFromScene(scene, box);
            addToScene(scene, clone);
            canvas.dataset.swapped = "true";
        }
        if (swapped && frame >= SWAP_FRAME + SETTLE_FRAMES) {
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
