// Scene 280 — Mirrored Double-Sided Winding (bundled-build regression).
//
// Two identical double-sided quads under an IBL: one with a plain transform, one under a
// negative-scale node. The negative scale makes the mirrored quad's net world determinant
// POSITIVE (glTF geometry is authored for the negative-determinant space the loader's RH->LH
// `__root__` flip creates), which reverses its triangle winding.
//
// Why this scene exists
// ---------------------
// A mirrored mesh must have its pipeline `frontFace` flipped ccw->cw. WebGPU derives
// `@builtin(front_facing)` from `frontFace`, and the double-sided PBR shader flips the shading
// normal when a fragment is not front-facing. Get the winding wrong and that flip fires on the
// VISIBLE side instead: the outward normal is inverted, N·V goes negative, and the quad loses its
// lighting and renders near-black.
//
// The scenes that already cover mirrored glTF nodes (257 / 266 / 269) do not catch this. Their
// mirrored meshes are shaped and lit such that flipping `frontFace` changes no pixels — verified by
// forcing the wrong winding and re-rendering them. This scene is deliberately built so the flip is
// the ONLY thing separating a lit quad from a black one, and both quads are on screen so the
// mirrored one is compared against its unmirrored twin.
//
// It is a BUNDLED-build regression in particular: the winding used to be installed by importing
// a module purely for its side effect, which the scene bundler tree-shakes away (nothing reads a
// binding from it). Source builds kept it, so only a bundled scene shows the failure.
//
// Flat quads with no texture: nothing here depends on UVs, tangents or mips, so a difference can
// only come from the winding.

import { addToScene, createArcRotateCamera, createEngine, createSceneContext, loadEnvironment, loadGltf, registerScene, startEngine } from "babylon-lite";

const MODEL_URL = "/gltf-assets/MirroredDoubleSided/MirroredDoubleSided.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1.0 };

    // Straight-on view: both quads face the camera, so a correctly wound pair is uniformly lit and
    // any winding error shows up as one dark quad beside a lit one.
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 6, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 100;

    // IBL only — no punctual light. The whole image is then a function of the shading normal, which
    // is exactly what the winding bug corrupts.
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    addToScene(scene, await loadGltf(engine, MODEL_URL));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

void main();
