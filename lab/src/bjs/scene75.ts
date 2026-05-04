import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const SCENE_CLEAR_COLOR = new Color4(51 / 255, 51 / 255, 76 / 255, 1.0);

const FRAGMENT_SHADER = `
precision lowp float;
varying vec2 vUV;
uniform float test;

void main(void) {
    float toto = test / test;
    if (toto == 1.0) {
        gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);
    } else if (toto >= 0.999999 && toto < 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0);
    } else {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    }
}
`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = SCENE_CLEAR_COLOR;

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    const material = new PBRMaterial("mat", scene);
    material.unlit = true;
    sphere.material = material;

    const camera = new ArcRotateCamera("default camera", -Math.PI / 2, Math.PI / 2, Math.sqrt(12) * 1.5, Vector3.Zero(), scene);
    camera.minZ = camera.radius * 0.01;
    camera.maxZ = camera.radius * 1000;
    scene.activeCamera = camera;

    const renderTexture = new RenderTargetTexture("OffScreen", 512, scene);
    material.albedoTexture = renderTexture;

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "scene75-effect-rtt-sphere",
        fragmentShader: FRAGMENT_SHADER,
        useShaderStore: false,
        uniforms: ["test"],
        samplers: [],
        allowEmptySourceTexture: true,
    });

    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setFloat("test", 15);
    });

    await new Promise<void>((resolve) => {
        wrapper.effect.executeWhenCompiled(() => resolve());
    });
    await scene.whenReadyAsync();

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
        renderer.render(wrapper, renderTexture);
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
    });

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
