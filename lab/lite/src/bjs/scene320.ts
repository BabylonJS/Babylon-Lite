// Upstream "Textured - Area Lights - PBR", Playground #T7FXR8#102.
// Only diagnostic AxesViewer arrows are omitted.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { AreaLightTextureTools } from "@babylonjs/core/Misc/areaLightsTextureTools";
import { Scene } from "@babylonjs/core/scene";

async function addEmitter(scene: Scene, processor: AreaLightTextureTools, position: Vector3, name: string, asset: string): Promise<void> {
    const panel = MeshBuilder.CreateBox(`box${name}`, { width: 6, height: 6, depth: 0.01 }, scene);
    panel.position = position;
    panel.rotation.set(5.976007358828584, 1.5969762655748114, 0);
    panel.scaling.set(2, 2, 2);
    const material = new StandardMaterial(`panel${name}`, scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    panel.material = material;

    const light = new RectAreaLight(`light${name}`, Vector3.Zero(), 6, 6, scene);
    light.parent = panel;
    light.diffuse = Color3.White();
    light.specular = Color3.White();
    light.intensity = 2;
    const source = new Texture(`https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/${asset}`, scene);
    const processed = await processor.processAsync(source);
    if (!processed) {
        throw new Error("Area-light texture processing failed");
    }
    light.emissionTexture = processed;
    material.diffuseTexture = source;
    material.emissiveTexture = source;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new ArcRotateCamera("camera1", 3.78, 1.15, 93.92, new Vector3(15, 10, -15), scene);
    camera.attachControl(canvas, true);

    const processor = new AreaLightTextureTools(engine);
    await addEmitter(scene, processor, new Vector3(10, 10, 0), "light1", "White.png");
    await addEmitter(scene, processor, new Vector3(15, 10, -15), "light2", "Cyberpunk3_AI_Square.png");
    await addEmitter(scene, processor, new Vector3(10, 10, -30), "light3", "Grey.png");
    canvas.dataset.emissionReady = "true";

    const material = new PBRMaterial("pbrMaterial", scene);
    material.roughness = 0.1;
    material.metallic = 0;
    material.albedoColor = Color3.Gray();
    const ground = MeshBuilder.CreateGround("ground", { width: 120, height: 120 }, scene);
    ground.material = material;

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
