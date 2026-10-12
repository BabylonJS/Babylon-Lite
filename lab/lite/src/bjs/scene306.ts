import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ExternalTexture } from "@babylonjs/core/Materials/Textures/externalTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { createScene306ExternalVideo } from "../shared/scene306-external-video";

const vertexSource = `attribute position: vec3<f32>;
attribute uv: vec2<f32>;
varying vUV: vec2<f32>;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = vec4<f32>(vertexInputs.position.xy, 0.0, 1.0);
    vertexOutputs.vUV = vertexInputs.uv;
}`;

const fragmentSource = `varying vUV: vec2<f32>;
var videoSampler: texture_external;
var videoSamplerSampler: sampler;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = textureSampleBaseClampToEdge(videoSampler, videoSamplerSampler, fragmentInputs.vUV);
}`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const videoFixture = await createScene306ExternalVideo();
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(16 / 255, 24 / 255, 40 / 255, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 4, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const material = new ShaderMaterial(
        "scene306ExternalTexture",
        scene,
        { vertexSource, fragmentSource },
        {
            attributes: ["position", "uv"],
            externalTextures: ["videoSampler"],
            shaderLanguage: ShaderLanguage.WGSL,
        }
    );
    material.backFaceCulling = false;
    material.setExternalTexture("videoSampler", new ExternalTexture(videoFixture.video));

    const plane = MeshBuilder.CreatePlane("externalTexturePlane", { size: 2 }, scene);
    plane.material = material;

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    window.addEventListener("beforeunload", () => videoFixture.dispose(), { once: true });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
