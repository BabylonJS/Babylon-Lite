import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

Effect.ShadersStore["scene163VertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vUV = uv;
}`;

Effect.ShadersStore["scene163FragmentShader"] = `
precision highp float;
varying vec2 vUV;
void main(void) {
    if (distance(vUV, vec2(0.5, 0.5)) < 0.18) {
        discard;
    }
    gl_FragColor = vec4(1.0, 0.25, 0.05, 0.55);
}`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(51 / 255, 51 / 255, 76 / 255, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 4.0, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const material = new ShaderMaterial(
        "scene163Shader",
        scene,
        { vertex: "scene163", fragment: "scene163" },
        { attributes: ["position", "uv"], uniforms: ["worldViewProjection"], needAlphaBlending: true, needAlphaTesting: true }
    );
    material.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane("plane", { width: 3, height: 3 }, scene);
    plane.material = material;

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
