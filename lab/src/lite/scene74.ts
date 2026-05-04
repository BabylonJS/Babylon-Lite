import { createEffectRenderer, createEffectWrapper, createEngine, registerEffectRenderer, startEngine } from "babylon-lite";

const FRAGMENT_WGSL = `fn crispLine(value:f32,width:f32)->f32{return 1.0-smoothstep(width,width+0.004,abs(fract(value)-0.5));}
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{let uv=input.uv;let p=(uv*2.0-vec2<f32>(1.0,1.0))*vec2<f32>(1.7777778,1.0);let r=length(p);let diagonal=smoothstep(-0.85,0.95,uv.x*1.15+uv.y*0.85-0.55);var color=mix(vec3<f32>(0.015,0.035,0.095),vec3<f32>(0.35,0.12,0.52),diagonal);let glow=exp(-r*2.25);color+=glow*vec3<f32>(0.95,0.34,0.74);let rings=crispLine(r*7.5,0.028)*smoothstep(0.95,0.12,r);color+=rings*vec3<f32>(0.92,0.96,1.0);let gridUv=uv*vec2<f32>(18.0,10.0);let grid=max(crispLine(gridUv.x+uv.y*2.0,0.018),crispLine(gridUv.y-uv.x*1.5,0.018));color+=grid*0.16*vec3<f32>(0.22,0.75,1.0);let core=smoothstep(0.38,0.0,r);color=mix(color,vec3<f32>(1.0,0.78,0.36),core*0.34);return vec4<f32>(clamp(color,vec3<f32>(0.0),vec3<f32>(1.0)),1.0);}`;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const effect = createEffectWrapper(engine, {
        name: "scene74-effect-renderer",
        fragmentWGSL: FRAGMENT_WGSL,
    });

    const renderer = createEffectRenderer(engine, effect, {
        name: "scene74-effect",
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
