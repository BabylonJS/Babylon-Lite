import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createExternalTexture,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setShaderExternalTexture,
    startEngine,
} from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";
import { createScene306ExternalVideo } from "../shared/scene306-external-video";

const vertexSource = wgsl`struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4<f32>(input.position.xy, 0.0, 1.0);
    out.uv = input.uv;
    return out;
}`;

const fragmentSource = wgsl`struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(videoSampler, videoSamplerSampler, input.uv);
}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const data = canvas.dataset;
    const videoFixture = await createScene306ExternalVideo();
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 16 / 255, g: 24 / 255, b: 40 / 255, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });

    const material = createShaderMaterial({
        name: "scene306ExternalTexture",
        vertexSource,
        fragmentSource,
        attributes: ["position", "uv"],
        externalTextures: ["videoSampler"],
        backFaceCulling: false,
    });
    setShaderExternalTexture(material, "videoSampler", createExternalTexture(videoFixture.video));

    const plane = createPlane(engine, { width: 2, height: 2 });
    plane.material = material;
    addToScene(scene, plane);

    window.addEventListener("beforeunload", () => videoFixture.dispose(), { once: true });
    await registerScene(scene);
    await startEngine(engine);
    data.drawCalls = String(engine.drawCallCount);
    data.initMs = String(performance.now() - initStart);
    data.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
