import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

Effect.ShadersStore["scene162VertexShader"] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["scene162FragmentShader"] = `
precision highp float;
void main(void) {
#ifdef USE_BLUE
    gl_FragColor = vec4(0.10, 0.28, 1.00, 1.0);
#else
    gl_FragColor = vec4(1.00, 0.10, 0.10, 1.0);
#endif
}`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(51 / 255, 51 / 255, 76 / 255, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.25, 4.2, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const material = new ShaderMaterial(
        "scene162Shader",
        scene,
        { vertex: "scene162", fragment: "scene162" },
        { attributes: ["position"], uniforms: ["worldViewProjection"], defines: ["USE_BLUE"] }
    );
    const torus = MeshBuilder.CreateTorus("torus", { diameter: 2.0, thickness: 0.45, tessellation: 64 }, scene);
    torus.material = material;

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
