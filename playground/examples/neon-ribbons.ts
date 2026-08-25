/**
 * Neon Ribbons — a pure Babylon Lite fullscreen WGSL effect (no scene, camera,
 * or mesh). A shadertoy-style field of flowing neon wave-ribbons: several layered
 * sine curves drift across the screen, each emitting a soft glow whose width
 * pulses with its own amplitude, tinted from the Babylon brand palette
 * (red / coral / light) over a dark wash. Adapted from the demos landing page.
 */
import { createEngine, startEngine, createEffectWrapper, createEffectRenderer, registerEffectRenderer, setEffectUniforms } from "@babylonjs/lite";

const FRAGMENT_WGSL = /* wgsl */ `
struct U {
iResolution : vec2f,
iTime : f32,
uIntensity : f32,
};
@group(0) @binding(0) var<uniform> u : U;

const RED   = vec3f(0.733, 0.275, 0.294); // #bb464b
const CORAL = vec3f(0.878, 0.408, 0.294); // #e0684b
const LIGHT = vec3f(0.878, 0.871, 0.847); // #e0ded8
const DARK  = vec3f(0.040, 0.026, 0.032);

// Cyclic palette ramp across the ribbons: red -> coral -> light -> red.
fn palette(h: f32) -> vec3f {
let x = fract(h);
if (x < 0.4) { return mix(RED, CORAL, x / 0.4); }
if (x < 0.7) { return mix(CORAL, LIGHT, (x - 0.4) / 0.3); }
return mix(LIGHT, RED, (x - 0.7) / 0.3);
}

@fragment fn effectFragment(@location(0) uv: vec2f) -> @location(0) vec4f {
let res = u.iResolution;
let t = u.iTime;
let p = (uv * res - 0.5 * res) / res.y;

// dark brand background with a soft central red bloom
var col = mix(DARK, RED * 0.16, smoothstep(1.1, -0.2, length(p)));

const N = 9;
var glowSum = 0.0;
for (var i = 0; i < N; i = i + 1) {
let fi = f32(i);
let sp = fi / f32(N - 1);

let ph = fi * 0.7;
let amp = 0.28 + 0.10 * sin(t * 0.3 + ph);
let y =
amp * sin(p.x * 1.3 + t * 0.6 + ph) +
amp * 0.55 * sin(p.x * 2.7 - t * 0.45 + ph * 1.7) +
amp * 0.30 * sin(p.x * 5.1 + t * 0.9 + ph * 2.3);

let base = (sp - 0.5) * 1.7 + 0.06 * sin(t * 0.2 + fi);
let dist = abs(p.y - (base + y));

let width = 0.012 + 0.006 * sin(t * 0.7 + ph);
let core = width / (dist + width);
let glow = 0.10 / (dist * dist * 45.0 + 0.08);

let hue = sp * 0.8 + 0.10 * sin(t * 0.15 + fi) + p.x * 0.04;
let cribbon = palette(hue);

col += cribbon * (core * 0.6 + glow * 0.28);
glowSum += glow;
}

col += CORAL * clamp(glowSum * 0.02, 0.0, 0.4) * u.uIntensity;
col = col * u.uIntensity;
col = col * mix(0.7, 1.0, smoothstep(1.6, 0.2, length(p)));
col = min(col, vec3f(0.82));
col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.92));
return vec4f(col, 1.0);
}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const effect = createEffectWrapper(engine, {
        name: "neon-ribbons",
        fragmentWGSL: FRAGMENT_WGSL,
        bindings: [{ binding: 0, kind: "uniform", uniformByteLength: 16 }],
    });

    const u = new Float32Array(4);
    const start = performance.now();

    const renderer = createEffectRenderer(engine, effect, {
        update: () => {
            u[0] = canvas.width;
            u[1] = canvas.height;
            u[2] = (performance.now() - start) / 1000;
            u[3] = 1.0; // uIntensity
            setEffectUniforms(effect, u);
        },
    });

    registerEffectRenderer(renderer);
    await startEngine(engine);
}

void main().catch((err) => console.error(err));
