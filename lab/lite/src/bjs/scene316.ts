// Adapted from upstream areaLightsPBRMaterial, Playground #T7FXR8#12.
// Only diagnostic AxesViewer arrows are omitted.
import { FlyCamera } from "@babylonjs/core/Cameras/flyCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

function addEmitter(scene: Scene, position: Vector3, rotation: Vector3, color: Color3, name: string): void {
    const panel = MeshBuilder.CreateBox(`box${name}`, { width: 6, height: 6, depth: 0.01 }, scene);
    panel.position = position;
    panel.rotation = rotation;
    const material = new StandardMaterial(`panel${name}`, scene);
    material.disableLighting = true;
    material.emissiveColor = color;
    panel.material = material;

    const light = new RectAreaLight(`light${name}`, Vector3.Zero(), 6, 6, scene);
    light.parent = panel;
    light.diffuse = color;
    light.specular = color;
    light.intensity = 0.7;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new FlyCamera("camera1", new Vector3(-20, 15, -15), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(true);

    addEmitter(scene, new Vector3(2, 3, -1), new Vector3(5.976007358828584, 1.5969762655748114, 0), Color3.White(), "light1");
    addEmitter(scene, new Vector3(-3, 3, 10), new Vector3(5.681046715241543, 0, 0), Color3.Red(), "light2");
    addEmitter(scene, new Vector3(-10, 3, -1), new Vector3(5.681046715241543, -1.5969762655748114, 0), Color3.Green(), "light3");

    const white = new PBRMaterial("StandardMaterial", scene);
    white.roughness = 0.1;
    white.metallic = 0.1;
    white.albedoColor = Color3.White();
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.y = 1;
    sphere.material = white;
    const ground = MeshBuilder.CreateGround("ground", { width: 120, height: 120 }, scene);
    ground.material = white;

    const red = new PBRMaterial("StandardMaterial2", scene);
    red.roughness = 0.9;
    red.metallic = 0.9;
    red.albedoColor = Color3.Red();
    const sphere2 = MeshBuilder.CreateSphere("sphere2", { diameter: 3, segments: 32 }, scene);
    sphere2.position.set(-3, 3, 0);
    sphere2.material = red;

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
