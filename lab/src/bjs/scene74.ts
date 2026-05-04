import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;

float crispLine(float value, float width) {
    return 1.0 - smoothstep(width, width + 0.004, abs(fract(value) - 0.5));
}

void main(void) {
    vec2 uv = vUV;
    vec2 p = (uv * 2.0 - 1.0) * vec2(1.7777778, 1.0);
    float r = length(p);
    float diagonal = smoothstep(-0.85, 0.95, uv.x * 1.15 + uv.y * 0.85 - 0.55);
    vec3 color = mix(vec3(0.015, 0.035, 0.095), vec3(0.35, 0.12, 0.52), diagonal);

    float glow = exp(-r * 2.25);
    color += glow * vec3(0.95, 0.34, 0.74);

    float rings = crispLine(r * 7.5, 0.028) * smoothstep(0.95, 0.12, r);
    color += rings * vec3(0.92, 0.96, 1.0);

    vec2 gridUv = uv * vec2(18.0, 10.0);
    float grid = max(crispLine(gridUv.x + uv.y * 2.0, 0.018), crispLine(gridUv.y - uv.x * 1.5, 0.018));
    color += grid * 0.16 * vec3(0.22, 0.75, 1.0);

    float core = smoothstep(0.38, 0.0, r);
    color = mix(color, vec3(1.0, 0.78, 0.36), core * 0.34);

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "scene74-effect-renderer",
        fragmentShader: FRAGMENT_SHADER,
        useShaderStore: false,
        uniforms: [],
        samplers: [],
        allowEmptySourceTexture: true,
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
