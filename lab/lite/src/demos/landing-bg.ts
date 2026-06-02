/**
 * Landing background effect — a pure Babylon Lite fullscreen WGSL effect (no
 * scene, camera, or mesh) used as the live backdrop of the demos landing page.
 *
 * A shadertoy-style field of flowing neon wave-ribbons: several layered sine
 * curves drift across the screen, each emitting a soft glow whose width pulses
 * with its own amplitude. Every ribbon is tinted from the official Babylon
 * Brand-Toolkit palette (red / coral / light) over a dark brand wash.
 */
import { createEngine, startEngine, stopEngine, createEffectWrapper, createEffectRenderer, registerEffectRenderer, setEffectUniforms } from "babylon-lite";

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
// Must close the loop (x=1 maps back to RED) so the fract() wrap is seamless;
// otherwise the wrap creates a hard colour jump that appears as a vertical bar
// drifting horizontally with p.x / time.
fn palette(h: f32) -> vec3f {
let x = fract(h);
if (x < 0.4) { return mix(RED, CORAL, x / 0.4); }
if (x < 0.7) { return mix(CORAL, LIGHT, (x - 0.4) / 0.3); }
return mix(LIGHT, RED, (x - 0.7) / 0.3);
}

@fragment fn effectFragment(@location(0) uv: vec2f) -> @location(0) vec4f {
let res = u.iResolution;
let t = u.iTime;
// centred coords, aspect-correct; x in roughly [-asp, asp], y in [-1, 1]
let asp = res.x / res.y;
let p = (uv * res - 0.5 * res) / res.y;

// dark brand background with a soft central red bloom
var col = mix(DARK, RED * 0.16, smoothstep(1.1, -0.2, length(p)));

const N = 9;
var glowSum = 0.0;
for (var i = 0; i < N; i = i + 1) {
let fi = f32(i);
let sp = fi / f32(N - 1);          // 0..1 across the stack

// each ribbon = a sum of a few sines (a "few more waves") drifting in x & t
let ph = fi * 0.7;
let amp = 0.28 + 0.10 * sin(t * 0.3 + ph);
let y =
amp * sin(p.x * 1.3 + t * 0.6 + ph) +
amp * 0.55 * sin(p.x * 2.7 - t * 0.45 + ph * 1.7) +
amp * 0.30 * sin(p.x * 5.1 + t * 0.9 + ph * 2.3);

// vertical home position of this ribbon, gently breathing
let base = (sp - 0.5) * 1.7 + 0.06 * sin(t * 0.2 + fi);
let dist = abs(p.y - (base + y));

// thin core + soft halo -> neon ribbon (toned-down glow)
let width = 0.012 + 0.006 * sin(t * 0.7 + ph);
let core = width / (dist + width);
let glow = 0.10 / (dist * dist * 45.0 + 0.08);

let hue = sp * 0.8 + 0.10 * sin(t * 0.15 + fi) + p.x * 0.04;
let cribbon = palette(hue);

col += cribbon * (core * 0.6 + glow * 0.28);
glowSum += glow;
}

// gentle blooming on the ribbons (kept restrained)
col += CORAL * clamp(glowSum * 0.02, 0.0, 0.4) * u.uIntensity;

// tone + vignette for text contrast
col = col * u.uIntensity;
col = col * mix(0.7, 1.0, smoothstep(1.6, 0.2, length(p)));
// clamp peak brightness so ribbons never blow out to white
col = min(col, vec3f(0.82));
col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.92));
return vec4f(col, 1.0);
}`;

/** Fall back to the page's branded static background and disable the (WebGPU-only)
 *  demos so they can't be opened into a broken page. */
function useStaticFallback(): void {
    document.body.classList.add("no-webgpu");
    document.querySelectorAll<HTMLAnchorElement>("a.card").forEach((card) => {
        card.removeAttribute("href");
        card.setAttribute("aria-disabled", "true");
        card.setAttribute("tabindex", "-1");
        card.addEventListener("click", (e) => e.preventDefault());
    });
}

async function main(): Promise<void> {
    const canvas = document.getElementById("bgCanvas") as HTMLCanvasElement | null;
    if (!canvas) {
        return;
    }

    // No WebGPU (or forced off via ?nowebgpu for testing) -> branded static page.
    const forcedOff = new URLSearchParams(location.search).has("nowebgpu");
    if (forcedOff || !("gpu" in navigator)) {
        useStaticFallback();
        return;
    }

    const engine = await createEngine(canvas);

    const effect = createEffectWrapper(engine, {
        name: "landing-bg",
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
    canvas.dataset.ready = "true";

    setupToggle(engine);
}

/** Wire the subtle on-page toggle that pauses/resumes the live effect. The
 *  preference is remembered across visits via localStorage. */
function setupToggle(engine: Parameters<typeof stopEngine>[0]): void {
    const btn = document.getElementById("fxToggle");
    if (!btn) {
        return;
    }

    const KEY = "bjs-landing-effect";
    let running = true;

    const apply = (on: boolean): void => {
        if (on === running) {
            // still sync the DOM (e.g. initial load) without touching the loop
        } else if (on) {
            void startEngine(engine);
        } else {
            stopEngine(engine);
        }
        running = on;
        document.body.classList.toggle("effect-off", !on);
        btn.classList.toggle("off", !on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.setAttribute("title", on ? "Turn the background effect off" : "Turn the background effect on");
    };

    // Restore a previously chosen "off" state (default is on).
    if (localStorage.getItem(KEY) === "off") {
        apply(false);
    }

    btn.addEventListener("click", () => {
        const next = !running;
        apply(next);
        try {
            localStorage.setItem(KEY, next ? "on" : "off");
        } catch {
            /* storage may be unavailable (private mode) — ignore */
        }
    });
}

void main().catch((err) => {
    console.error("landing-bg effect failed:", err);
    useStaticFallback();
});
