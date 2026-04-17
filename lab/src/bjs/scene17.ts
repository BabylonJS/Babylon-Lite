import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    // Cube 1: PBR with thin instances (yellow / red)
    const cube = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    cube.position.y = 1;

    const matrix1 = Matrix.Translation(-2, 2, 0);
    const matrix2 = Matrix.IdentityReadOnly;

    const bufferMatrices = new Float32Array(16 * 2);
    matrix1.copyToArray(bufferMatrices, 0);
    matrix2.copyToArray(bufferMatrices, 16);

    const bufferColors = new Float32Array(4 * 2);
    bufferColors.set([1, 1, 0, 1, 1, 0, 0, 1]);

    cube.thinInstanceSetBuffer("matrix", bufferMatrices);
    cube.thinInstanceSetBuffer("color", bufferColors, 4);

    const pbr = new PBRMaterial("pbr", scene);
    pbr.albedoColor = new Color3(1.0, 0.766, 0.336);
    pbr.metallic = 1.0;
    pbr.roughness = 1.0;
    pbr.reflectionTexture = CubeTexture.CreateFromPrefilteredData("https://playground.babylonjs.com/textures/environment.dds", scene);
    pbr.metallicTexture = new Texture("https://playground.babylonjs.com/textures/mr.jpg", scene);
    pbr.useRoughnessFromMetallicTextureAlpha = false;
    pbr.useRoughnessFromMetallicTextureGreen = true;
    pbr.useMetallnessFromMetallicTextureBlue = true;
    cube.material = pbr;

    // Cube 2: Standard with thin instances (green / blue)
    const cube2 = MeshBuilder.CreateBox("box2", { size: 1 }, scene);
    cube2.position.y = 1;

    const matrix3 = Matrix.Compose(new Vector3(-1, 1, 1), Quaternion.Identity(), new Vector3(2, 1, 0));
    const matrix4 = Matrix.Compose(new Vector3(-1, 1, 1), Quaternion.Identity(), new Vector3(-2, 0, -3));

    const bufferMatrices2 = new Float32Array(16 * 2);
    matrix3.copyToArray(bufferMatrices2, 0);
    matrix4.copyToArray(bufferMatrices2, 16);

    const bufferColors2 = new Float32Array(4 * 2);
    bufferColors2.set([0, 1, 0, 1, 0, 0, 1, 1]);

    cube2.thinInstanceSetBuffer("matrix", bufferMatrices2);
    cube2.thinInstanceSetBuffer("color", bufferColors2, 4);

    const mat2 = new StandardMaterial("mat2", scene);
    cube2.material = mat2;
    mat2.sideOrientation = Material.ClockWiseSideOrientation;

    // Ground
    MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
