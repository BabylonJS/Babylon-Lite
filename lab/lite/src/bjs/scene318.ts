// Complement to upstream fixtures: parent scale, light-local rotation, mixed
// lights, one-sided emission, and PR #16723 metallic/albedo regression.
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("camera", new Vector3(-9, 8, -15), scene);
    camera.setTarget(new Vector3(0, 1.5, 1));
    camera.minZ = 1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const parent = new TransformNode("scaled-emitter", scene);
    parent.position.set(0, 4, 5);
    parent.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, -0.55, 0);
    parent.scaling.set(1.5, 0.75, 1.2);

    // BJS lights have no local quaternion; a child transform supplies the same
    // local yaw that Lite stores directly on its SceneNode light.
    const aim = new TransformNode("emitter-local-rotation", scene);
    aim.parent = parent;
    aim.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.2, 0, 0);
    const light = new RectAreaLight("front-emitter", Vector3.Zero(), 2.5, 2, scene);
    light.parent = aim;
    light.intensity = 3;
    light.diffuse = Color3.White();
    light.specular = Color3.White();

    const panel = MeshBuilder.CreateBox("front-panel", { width: 2.5, height: 2, depth: 0.01 }, scene);
    // BJS light children do not inherit the transformed emitter frame.
    panel.parent = aim;
    const panelMaterial = new StandardMaterial("panel", scene);
    panelMaterial.disableLighting = true;
    panelMaterial.emissiveColor = Color3.White();
    panel.material = panelMaterial;

    // All receivers are behind this unrotated light's emitting -Z face.
    const back = new RectAreaLight("back-facing-magenta", new Vector3(0, 3, -2), 3, 2, scene);
    back.intensity = 8;
    back.diffuse = new Color3(1, 0, 1);
    back.specular = new Color3(1, 0, 1);
    const point = new PointLight("blue-point", new Vector3(-5, 5, -1), scene);
    point.intensity = 0.35;
    point.diffuse = new Color3(0.1, 0.3, 1);
    point.specular = new Color3(0.1, 0.3, 1);
    const hemi = new HemisphericLight("fill", Vector3.Up(), scene);
    hemi.intensity = 0.08;

    for (let i = 0; i < 4; i++) {
        const tinted = i % 2 === 1;
        const name = `pbr-${i < 2 ? "dielectric" : "metal"}-${tinted ? "tinted" : "white"}`;
        const material = new PBRMaterial(name, scene);
        material.albedoColor = tinted ? new Color3(0.8, 0.12, 0.04) : Color3.White();
        material.roughness = 0.25;
        material.metallic = i < 2 ? 0 : 1;
        const sphere = MeshBuilder.CreateSphere(name, { diameter: 1.7, segments: 32 }, scene);
        sphere.position.set(-3.3 + i * 2.2, 0.85, 0);
        sphere.material = material;
    }

    for (let i = 0; i < 2; i++) {
        const material = new StandardMaterial(`standard-${i}`, scene);
        material.diffuseColor = i === 0 ? new Color3(0.1, 0.6, 0.9) : new Color3(0.9, 0.45, 0.08);
        material.specularPower = i === 0 ? 16 : 128;
        const sphere = MeshBuilder.CreateSphere(`standard-${i}`, { diameter: 1.7, segments: 32 }, scene);
        sphere.position.set(i === 0 ? -1.4 : 1.4, 0.85, 3);
        sphere.material = material;
    }

    const groundMaterial = new StandardMaterial("ground", scene);
    groundMaterial.diffuseColor = new Color3(0.18, 0.18, 0.18);
    groundMaterial.specularColor = Color3.Black();
    const ground = MeshBuilder.CreateGround("ground", { width: 14, height: 8 }, scene);
    ground.position.z = 3;
    ground.material = groundMaterial;

    await scene.whenReadyAsync();
    canvas.dataset.ltcReady = "true";
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
