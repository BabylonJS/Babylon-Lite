// Scene 231 — StandardMaterial deform features (in-code, no glTF):
// per-vertex color + skeletal skinning + UV offset on a procedurally built beam,
// with bones animated programmatically (per-frame updates, no animation system).
//
// The beam is a tall box (4 vertically-subdivided side faces + caps) skinned to a
// 2-bone skeleton: a fixed root bone and an upper bone that swings about the beam
// origin. The pose is a pure function of the frame index, so freezing at a known
// frame (via ?seekTime) is deterministic and matches the Babylon.js reference.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { enableStandardSkeleton, enableStandardUvOffset, enableStandardVertexColor } from "babylon-lite/material/standard/enable-standard-mesh-features.js";
import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
import { boneMatrixData, buildBeamData, buildCheckerPixels, CHECKER_SIZE, SKELETON_BONE_COUNT, UV_OFFSET } from "../shared/scene231-skin.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.145, g: 0.165, b: 0.21, a: 1 };

    // Opt in to the Standard deform/vertex features used by this scene. Plain
    // Standard scenes that never call these stay byte-identical to upstream.
    enableStandardVertexColor();
    enableStandardSkeleton();
    enableStandardUvOffset();

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 5.5, { x: 0, y: 0, z: 0 });
    camera.fov = 0.72;
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const beam = buildBeamData();
    const mesh = createMeshFromData(engine, "scene231-beam", beam.positions, beam.normals, beam.indices, beam.uvs, undefined, undefined, beam.colors);

    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.diffuseTexture = createTexture2DFromPixels(engine, buildCheckerPixels(), CHECKER_SIZE, CHECKER_SIZE, { addressModeU: "repeat", addressModeV: "repeat" });
    material.uvOffset = UV_OFFSET;
    mesh.material = material;

    const boneData = boneMatrixData(0);
    mesh.skeleton = createSkeleton(engine, beam.joints, beam.weights, SKELETON_BONE_COUNT, boneData);
    addToScene(scene, mesh);

    // Per-frame programmatic bone animation: recompute the bone matrices as a pure
    // function of the frame index and re-upload them to the skeleton's bone texture.
    const boneTexWidth = SKELETON_BONE_COUNT * 4;
    const boneTexture = mesh.skeleton.boneTexture;
    scene.fixedDeltaMs = 16.0;

    const params = new URLSearchParams(window.location.search);
    const seek = parseFloat(params.get("seekTime") || "");
    const freezeFrame = isNaN(seek) ? -1 : Math.round(seek * 60);
    let frame = 0;
    let frozen = false;

    onBeforeRender(scene, () => {
        if (frozen) {
            return;
        }
        frame++;
        boneMatrixData(frame, boneData);
        engine._device.queue.writeTexture({ texture: boneTexture }, boneData.buffer as ArrayBuffer, { bytesPerRow: boneTexWidth * 16 }, { width: boneTexWidth, height: 1 });
        if (freezeFrame >= 0 && frame >= freezeFrame) {
            frozen = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
