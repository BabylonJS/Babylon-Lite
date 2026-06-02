import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

const SOURCE_RGBA = new Uint8Array([64, 188, 255, 255]);

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D inputTexture;

void main(void) {
    vec2 uv = clamp(vUV, vec2(0.0), vec2(1.0));
    vec3 tex = texture2D(inputTexture, uv).rgb;
    float diagonal = smoothstep(0.1, 0.9, uv.x * 0.72 + uv.y * 0.28);
    float edge = smoothstep(0.0, 0.35, uv.x) * smoothstep(1.0, 0.65, uv.x) * smoothstep(0.0, 0.35, uv.y) * smoothstep(1.0, 0.65, uv.y);
    vec3 accent = vec3(0.08 * uv.y, 0.04 * uv.x, 0.12 * (1.0 - uv.x));
    vec3 color = tex * (0.52 + 0.36 * diagonal + 0.12 * edge) + accent * tex.b;
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const inputTexture = RawTexture.CreateRGBATexture(SOURCE_RGBA, 1, 1, engine, false, false, Texture.NEAREST_SAMPLINGMODE);
    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "scene76-effect-texture",
        fragmentShader: FRAGMENT_SHADER,
        useShaderStore: false,
        uniforms: [],
        samplers: ["inputTexture"],
        allowEmptySourceTexture: true,
    });

    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setTexture("inputTexture", inputTexture);
    });

    await new Promise<void>((resolve) => {
        wrapper.effect.executeWhenCompiled(() => resolve());
    });

    engine.runRenderLoop(() => {
        renderer.render(wrapper);
    });
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    renderer.render(wrapper);
    canvas.dataset.drawCalls = "1";
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
