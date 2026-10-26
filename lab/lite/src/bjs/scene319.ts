// Upstream "Textured - Area Lights - Standard Material", Playground #T7FXR8#103.
// Diagnostic AxesViewer arrows and ineffective Standard metallic/albedo fields are omitted.
import { FlyCamera } from "@babylonjs/core/Cameras/flyCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { AreaLightTextureTools } from "@babylonjs/core/Misc/areaLightsTextureTools";
import { Scene } from "@babylonjs/core/scene";

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

    const panel = MeshBuilder.CreateBox("boxlight1", { width: 6, height: 6, depth: 0.01 }, scene);
    panel.position.set(2, 10, 0);
    panel.rotation.set(5.976007358828584, 1.5969762655748114, 0);
    panel.scaling.set(2, 2, 2);
    const panelMaterial = new StandardMaterial("panellight1", scene);
    panelMaterial.disableLighting = true;
    panelMaterial.emissiveColor = Color3.White();
    panel.material = panelMaterial;

    const light = new RectAreaLight("lightlight1", Vector3.Zero(), 6, 6, scene);
    light.parent = panel;
    light.diffuse = Color3.White();
    light.specular = Color3.White();
    light.intensity = 1;
    const source = new Texture("https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/Cyberpunk_AI_Square.png", scene);
    const processor = new AreaLightTextureTools(engine);
    const processed = await processor.processAsync(source);
    if (!processed) {
        throw new Error("Area-light texture processing failed");
    }
    light.emissionTexture = processed;
    panelMaterial.diffuseTexture = source;
    panelMaterial.emissiveTexture = source;
    canvas.dataset.emissionReady = "true";

    const material = new StandardMaterial("StandardMaterial", scene);
    material.roughness = 0.2;
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.y = 1;
    sphere.material = material;
    const ground = MeshBuilder.CreateGround("ground", { width: 120, height: 120 }, scene);
    ground.material = material;
    const material2 = new StandardMaterial("StandardMaterial2", scene);
    material2.roughness = 0.9;
    const sphere2 = MeshBuilder.CreateSphere("sphere2", { diameter: 3, segments: 32 }, scene);
    sphere2.position.set(-3, 3, 0);
    sphere2.material = material2;

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
