// BJS reference for scene 269 — mirrored-transform coverage.
// Mirrors the Lite scene exactly: same camera, environment, tone mapping and three object groups.
// Babylon handles all of these natively (setParent decomposes with a signed scale, glTF `matrix`
// nodes are decomposed to TRS at load, and sideOrientation is recomputed from the world determinant),
// so it is a clean reference for the Lite fixes.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MODEL_DIR = "/gltf-assets/Node_NegativeScale/";
const MODEL_FILE = "Node_NegativeScale_01.gltf";

/** Apply a yaw + uniform scale + translation to a transform node. */
function place(node: TransformNode, x: number, y: number, z: number, yaw: number, scale: number): void {
    node.position.set(x, y, z);
    node.rotationQuaternion = new Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    node.scaling.set(scale, scale, scale);
}

void (async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3.2, 42, new Vector3(0, 1, 0), scene);
    camera.minZ = 1;
    camera.maxZ = 1000;
    camera.attachControl(canvas, true);

    new HemisphericLight("light", new Vector3(0, 1, 0), scene);

    const envTex = CubeTexture.CreateFromPrefilteredData("https://assets.babylonjs.com/core/environments/environmentSpecular.env", scene);
    envTex.gammaSpace = false;
    scene.environmentTexture = envTex;
    scene.environmentIntensity = 1.0;

    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    const byName = (nodes: Node[], name: string): TransformNode => nodes.find((n) => n.name === name) as TransformNode;

    // ── 1. Mirrored glTF root reparented, then the new parent is moved ────────
    const resultA = await SceneLoader.ImportMeshAsync("", MODEL_DIR, MODEL_FILE, scene);
    const rootA = byName([...resultA.transformNodes, ...resultA.meshes], "__root__");
    const newRootA = new TransformNode("newRootA", scene);
    rootA.setParent(newRootA);
    place(newRootA, -13, 0, 0, Math.PI / 7, 0.8);

    // ── 2. Matrix-declared glTF node pulled out, then its new parent is moved ─
    const resultB = await SceneLoader.ImportMeshAsync("", MODEL_DIR, MODEL_FILE, scene);
    const nodesB = [...resultB.transformNodes, ...resultB.meshes];
    byName(nodesB, "__root__").position.set(-5, 0, -14);
    const newRootB = new TransformNode("newRootB", scene);
    byName(nodesB, "Node1").setParent(newRootB);
    place(newRootB, -5, 0, 2, -Math.PI / 9, 0.8);

    // ── 3. PBR box mirrored at runtime ────────────────────────────────────────
    const pbrBox = CreateBox("pbrBox", { size: 3 }, scene);
    pbrBox.position.set(6, 1.5, 0);
    const pbrMat = new PBRMaterial("pbrMat", scene);
    pbrMat.albedoColor = new Color3(0.85, 0.35, 0.25);
    pbrMat.metallic = 0.0;
    pbrMat.roughness = 0.45;
    pbrBox.material = pbrMat;

    await scene.whenReadyAsync();

    // Same runtime mirror as Lite. Babylon re-derives sideOrientation from the world matrix, so no
    // pipeline rebuild is needed on this side.
    pbrBox.scaling.set(-1, 1, 1);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
