// BJS reference for scene 204 — floating-origin thin instances.
//
// Mirrors lab/lite/src/lite/scene204.ts exactly. The ONE intended substrate
// difference is `useLargeWorldRendering: true`. BJS composes thin instances
// as `finalWorld = mesh.world * instanceMatrix` (identical to Lite), so the
// large world coordinate lives in mesh.world, which BJS offsets eye-relative
// under floating origin. Instance matrices are local (small) — no per-instance
// offset. Keep all geometry/material/camera/light params in sync with the
// Lite scene.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene204.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

    const cam = new ArcRotateCamera("cam", Math.PI / 4, Math.PI / 3, 22, new Vector3(OFFSET, 1, OFFSET), scene);
    cam.minZ = 0.5;
    cam.maxZ = 500;
    cam.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.4;

    const dir = new DirectionalLight("dir", new Vector3(-0.4, -1, -0.2), scene);
    dir.diffuse = new Color3(1, 1, 1);
    dir.specular = new Color3(0.3, 0.3, 0.3);

    const ground = MeshBuilder.CreateGround("ground", { width: 60, height: 60, subdivisions: 1 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.25, 0.25, 0.3);
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    const boxMat = new StandardMaterial("boxMat", scene);
    boxMat.diffuseColor = new Color3(1, 1, 1);
    boxMat.specularColor = new Color3(0.4, 0.4, 0.4);
    box.material = boxMat;
    box.position.set(OFFSET, 1, OFFSET);

    const numPerSide = 5;
    const spacing = 4;
    const instanceCount = numPerSide * numPerSide;
    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);
    const m = Matrix.Identity();
    let index = 0;
    for (let i = 0; i < numPerSide; i++) {
        for (let j = 0; j < numPerSide; j++) {
            (m.m as unknown as number[])[12] = (i - 2) * spacing;
            (m.m as unknown as number[])[13] = ((i + j) % 3) * 0.75;
            (m.m as unknown as number[])[14] = (j - 2) * spacing;
            m.markAsUpdated();
            m.copyToArray(matricesData, index * 16);
            colorData[index * 4 + 0] = 0.3 + (i / (numPerSide - 1)) * 0.6;
            colorData[index * 4 + 1] = 0.4;
            colorData[index * 4 + 2] = 0.3 + (j / (numPerSide - 1)) * 0.6;
            colorData[index * 4 + 3] = 1.0;
            index++;
        }
    }
    box.thinInstanceSetBuffer("matrix", matricesData, 16);
    box.thinInstanceSetBuffer("color", colorData, 4);

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.useLargeWorldRendering = "true";
        canvas.dataset.ready = "true";
    });
})();
