// Scene 128 — BJS reference for Gaussian Splatting Depth Rendering (alpha-blended).
// Port of playground https://playground.babylonjs.com/#V80DRL#19.
//
// Same as scene 127 but adds `depthRenderer.alphaBlendedDepth = true` so the GS
// mesh writes its alpha-modulated depth into the depth RT for soft-edged splats.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { waitForGsSettled } from "./gs-settle";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/loaders/SPLAT/splatFileLoader";
import "@babylonjs/core/Materials/standardMaterial";
// The splat loader pulls the tree-shakeable GS material (`.pure`) but not the
// side-effect wrapper that registers the GS depth-pass shaders. Without these,
// the DepthRenderer tries to fetch `gaussianSplattingDepth.*` at runtime, gets
// the vite SPA fallback HTML instead, and the GS depth pipeline fails to
// compile — so the splat cloud is missing from the depth capture. Registering
// the WGSL shaders explicitly keeps the reference self-contained.
import "@babylonjs/core/ShadersWGSL/gaussianSplattingDepth.vertex";
import "@babylonjs/core/ShadersWGSL/gaussianSplattingDepth.fragment";

// Vendored locally (lab/public/splats/) to remove remote-CDN network variance
// from the CI parity capture. Served at the site root by the lab dev server.
const SPLAT_URL = "/splats/Halo_Believe.splat";

// Depth-visualisation post-process authored in WGSL.  The original playground
// used a GLSL post-process, but under the WebGPU engine a GLSL shader forces
// BJS to download the twgsl (GLSL->WGSL) transpiler from its CDN at runtime —
// a network dependency that flakes/black-renders the reference on CI.  Writing
// the shader in WGSL keeps the capture fully local and deterministic.
ShaderStore.ShadersStoreWGSL["customDepthPixelShader"] = `varying vUV: vec2f;
var depthSamplerSampler: sampler;
var depthSampler: texture_2d<f32>;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var depth: f32 = textureSample(depthSampler, depthSamplerSampler, input.vUV).r;
    fragmentOutputs.color = vec4f(depth, depth, depth, 1.0);
}`;

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

    const depthPostProcess = new PostProcess("depthPostProcess", "customDepth", {
        samplers: ["depthSampler"],
        size: 1.0,
        camera,
        shaderLanguage: ShaderLanguage.WGSL,
    });
    depthPostProcess.onApply = function (effect) {
        effect.setTexture("depthSampler", depthRenderer.getDepthMap());
    };

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // Wait for the GS depth sort to settle over several rendered frames so the
    // reference capture is deterministic (the old `_canPostToWorker` poll could
    // capture mid-sort with an unpopulated depth RTT — a black/flaky reference).
    await waitForGsSettled(scene, gs);

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
