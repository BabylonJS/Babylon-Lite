import { createEffectRenderer, createEffectWrapper, createEngine, createSolidTexture2D, registerEffectRenderer, setEffectTexture, startEngine } from "babylon-lite";

const FRAGMENT_WGSL = `@group(0) @binding(0) var inputTexture:texture_2d<f32>;
@group(0) @binding(1) var inputSampler:sampler;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{let uv=clamp(input.uv,vec2<f32>(0.0),vec2<f32>(1.0));let tex=textureSample(inputTexture,inputSampler,uv).rgb;let diagonal=smoothstep(0.1,0.9,uv.x*0.72+uv.y*0.28);let edge=smoothstep(0.0,0.35,uv.x)*smoothstep(1.0,0.65,uv.x)*smoothstep(0.0,0.35,uv.y)*smoothstep(1.0,0.65,uv.y);let accent=vec3<f32>(0.08*uv.y,0.04*uv.x,0.12*(1.0-uv.x));let color=tex*(0.52+0.36*diagonal+0.12*edge)+accent*tex.b;return vec4<f32>(clamp(color,vec3<f32>(0.0),vec3<f32>(1.0)),1.0);}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const inputTexture = createSolidTexture2D(engine, 64 / 255, 188 / 255, 1, 1);
    const effect = createEffectWrapper(engine, {
        name: "scene76-effect-texture",
        fragmentWGSL: FRAGMENT_WGSL,
        bindings: [
            { name: "inputTexture", binding: 0, kind: "texture" },
            { name: "inputSampler", binding: 1, kind: "sampler", textureBinding: "inputTexture" },
        ],
    });
    setEffectTexture(effect, "inputTexture", inputTexture);

    const renderer = createEffectRenderer(engine, effect, {
        name: "scene76-effect-texture",
        clear: true,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
    });
    registerEffectRenderer(renderer);

    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
