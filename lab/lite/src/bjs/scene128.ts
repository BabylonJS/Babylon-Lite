// Scene 128 — BJS reference for Gaussian Splatting Depth Rendering (alpha-blended).
// Port of playground https://playground.babylonjs.com/#V80DRL#19.
//
// Same as scene 127 but adds `depthRenderer.alphaBlendedDepth = true` so the GS
// mesh writes its alpha-modulated depth into the depth RT for soft-edged splats.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// TEMP (BJS 9.15+ pure/non-pure split): restores the createDepthStencilTexture side-effect dropped by tree-shaking; remove once upstream re-adds the transitive registration (open BJS PR).
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.texture";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
// TEMP (BJS 9.15+ pure/non-pure split): the depth renderer's WGSL shaders are no
// longer registered transitively, so under WebGPU they 404 and the depth map renders
// black. Import the depth + Gaussian-splatting-depth WGSL shaders explicitly; remove
// once upstream re-adds the transitive registration (open BJS PR).
import "@babylonjs/core/ShadersWGSL/depth.vertex";
import "@babylonjs/core/ShadersWGSL/depth.fragment";
import "@babylonjs/core/ShadersWGSL/gaussianSplattingDepth.vertex";
import "@babylonjs/core/ShadersWGSL/gaussianSplattingDepth.fragment";
import "@babylonjs/loaders/SPLAT/splatFileLoader";
import "@babylonjs/core/Materials/standardMaterial";

const SPLAT_URL = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/Halo_Believe.splat";

Effect.ShadersStore["customDepthPixelShader"] = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D depthSampler;
    uniform vec2 cameraMinMaxZ;
    void main(void) {
        float depth = texture2D(depthSampler, vUV).r;
        float linearDepth = depth;
        gl_FragColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
    }
`;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.5, 10, new Vector3(0, 1, 0), scene);
    camera.minZ = 0.03;
    camera.maxZ = 15;
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.x = -2;

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2 }, scene);
    sphere.position.x = 2;

    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);
    ground.position.y = -1;

    const result = await ImportMeshAsync(SPLAT_URL, scene);
    const gs = result.meshes[0]!;
    gs.position.y = 3;
    gs.position.z = 0;

    const depthRenderer = scene.enableDepthRenderer(camera);
    depthRenderer.forceDepthWriteTransparentMeshes = true;
    depthRenderer.alphaBlendedDepth = true;

    const depthPostProcess = new PostProcess("depthPostProcess", "customDepth", ["cameraMinMaxZ"], ["depthSampler"], 1.0, camera);
    depthPostProcess.onApply = function (effect) {
        effect.setTexture("depthSampler", depthRenderer.getDepthMap());
        effect.setVector2("cameraMinMaxZ", new Vector2(camera.minZ, camera.maxZ));
    };

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    const start = performance.now();
    while ((gs as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((r) => setTimeout(r, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
