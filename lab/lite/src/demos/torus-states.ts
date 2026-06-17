/**
 * Demo — Torus States.
 *
 * A reproduction of Robert Penner's "Torus States" (https://robertpenner.com/demos/#/torus-states),
 * rendered with Babylon Lite's scene-less frame-graph path — no scene, camera, or mesh.
 * The entire image is a single raymarched WGSL fragment shader (twisted-torus SDF with
 * volumetric glow, sine-palette color, Blinn-Phong specular + Fresnel) that auto-cycles
 * through 7 morph states. Demonstrates how thin a Lite-powered shader page can be.
 */
import {
    addTask,
    createBloomPostProcessTask,
    createEngine,
    createFrameGraphContext,
    createRenderTarget,
    createUniformEffectRenderTask,
    createUniformEffectWrapper,
    registerFrameGraphContext,
    setUniformEffectUniforms,
    startEngine,
} from "babylon-lite";
import { installFetchProgress } from "./loading-progress.js";

const FRAGMENT_WGSL = /* wgsl */ `
struct U {
iResolution : vec2f,
iTime : f32,
uAnimSpeed : f32,
uColorOffset : vec3f,
uFlowSpeed : f32,
uMajorR : f32,
uTubeSize : f32,
uTwistsPerRev : f32,
uStepDiv : f32,
uAspect : f32,
uSquircle : f32,
uRotXSpeed : f32,
uRotYSpeed : f32,
uGlowStrength : f32,
uSpecStrength : f32,
uSpecPower : f32,
uFresnelStrength : f32,
};
@group(0) @binding(0) var<uniform> u : U;
fn sdSuperellipseBox(p: vec2f, size: vec2f, cornerRadius: f32, exponent: f32) -> f32 {
let q = abs(p) - size * 0.5 + vec2f(cornerRadius);
let ox = max(q, vec2f(0.0));
let outside = pow(pow(ox.x, exponent) + pow(ox.y, exponent), 1.0 / exponent);
return min(max(q.x, q.y), 0.0) + outside - cornerRadius;
}
fn crossSectionSDF(p: vec2f, size: f32) -> f32 {
let dim = vec2f(u.uAspect, 1.0) * (size * 2.0);
let r = min(dim.x, dim.y) * 0.5;
return sdSuperellipseBox(p, dim, r, max(u.uSquircle, 2.0));
}
fn tanhFire(x: vec4f) -> vec4f {
let e = exp(clamp(2.0 * x, vec4f(-20.0), vec4f(20.0)));
return (e - 1.0) / (e + 1.0);
}
fn sdTwistedTorus(p: vec3f, t: f32, phi: ptr<function, f32>) -> f32 {
*phi = atan2(p.y, p.x);
let radial = length(p.xy) - u.uMajorR;
var local = vec2f(radial, p.z);
let angle = u.uTwistsPerRev * (*phi) + u.uFlowSpeed * t;
let c = cos(angle);
let s = sin(angle);
local = mat2x2f(c, s, -s, c) * local;
let sdf = crossSectionSDF(local, u.uTubeSize);
let ringR = max(length(p.xy), 1e-4);
let k = 1.0 + abs(u.uTwistsPerRev) * length(local) / ringR;
let sdfCorrected = sdf / k;
if (sdf < 0.0) { return sdfCorrected; }
let radialFloor = max(abs(radial) - u.uTubeSize * 1.41421356, 0.0);
return max(sdfCorrected, radialFloor);
}
fn calcNormal(p: vec3f, t: f32) -> vec3f {
var dummy = 0.0;
let h = 0.002;
let k = vec2f(1.0, -1.0);
return normalize(
k.xyy * sdTwistedTorus(p + k.xyy * h, t, &dummy) +
k.yyx * sdTwistedTorus(p + k.yyx * h, t, &dummy) +
k.yxy * sdTwistedTorus(p + k.yxy * h, t, &dummy) +
k.xxx * sdTwistedTorus(p + k.xxx * h, t, &dummy)
);
}
@fragment fn effectFragment(@location(0) uv: vec2f) -> @location(0) vec4f {
let res = u.iResolution;
let C = uv * res;
let t = u.iTime * u.uAnimSpeed;
let rd = normalize(vec3f(C - 0.5 * res, res.y));
let ax = u.uRotXSpeed * t;
let cax = cos(ax);
let sax = sin(ax);
let ay = u.uRotYSpeed * t;
let cay = cos(ay);
let say = sin(ay);
var rdRot = rd;
rdRot = vec3f(rdRot.x, cax * rdRot.y - sax * rdRot.z, sax * rdRot.y + cax * rdRot.z);
rdRot = vec3f(cay * rdRot.x + say * rdRot.z, rdRot.y, -say * rdRot.x + cay * rdRot.z);
var lig = normalize(vec3f(1.0, 2.0, -2.0));
lig = vec3f(lig.x, cax * lig.y - sax * lig.z, sax * lig.y + cax * lig.z);
lig = vec3f(cay * lig.x + say * lig.z, lig.y, -say * lig.x + cay * lig.z);
var o = vec3f(0.0);
var z = 0.0;
var d = 0.0;
var specFresnel = 0.0;
var surfaceHit = false;
for (var i = 0; i < 1200; i = i + 1) {
var p = z * rd;
p.z = p.z - 4.0;
let py = p.y;
let pz = p.z;
p = vec3f(p.x, cax * py - sax * pz, sax * py + cax * pz);
let px2 = p.x;
let pz2 = p.z;
p = vec3f(cay * px2 + say * pz2, p.y, -say * px2 + cay * pz2);
var phi = 0.0;
let rawSdf = sdTwistedTorus(p, t, &phi);
let sdf = abs(rawSdf);
d = sdf + 9e-3;
let col = vec3f(1.0) + sin(vec3f(0.5 + phi + t * 0.3) + u.uColorOffset);
o = o + col / d * u.uGlowStrength;
if (!surfaceHit && rawSdf < 0.0) {
surfaceHit = true;
let nor = calcNormal(p, t);
let hal = normalize(lig - rdRot);
let spec = pow(max(dot(nor, hal), 0.0), u.uSpecPower) * u.uSpecStrength;
let fresnel = pow(1.0 - abs(dot(rdRot, nor)), 3.0) * u.uFresnelStrength;
specFresnel = spec + fresnel;
}
z = z + max(sdf, 0.08) / u.uStepDiv;
if (z > u.uMajorR * 2.0 + 6.0) { break; }
}
let maxGlow = max(o.r, max(o.g, o.b));
let O = tanhFire(vec4f(o, maxGlow) / 2000.0);
let rgb = min(O.rgb + vec3f(specFresnel), vec3f(1.0));
let a = max(rgb.r, max(rgb.g, rgb.b));
return vec4f(rgb, a);
}`;

interface MorphState {
    aspect: number;
    squircle: number;
    colorOffset: [number, number, number];
    tubeSize: number;
}

// The 7 morph targets (Penner's states A–G).
const STATES: MorphState[] = [
    { aspect: 1.0, squircle: 2, colorOffset: [2, 3, 4], tubeSize: 0.224 },
    { aspect: 0.5, squircle: 2, colorOffset: [0.5, 1.5, 3.5], tubeSize: 0.208 },
    { aspect: 1.0, squircle: 4, colorOffset: [4, 2, 1], tubeSize: 0.24 },
    { aspect: 1.5, squircle: 3, colorOffset: [1, 4, 2.5], tubeSize: 0.2 },
    { aspect: 0.6, squircle: 2, colorOffset: [3.5, 0.5, 2], tubeSize: 0.224 },
    { aspect: 1.0, squircle: 6, colorOffset: [0, 2.5, 5], tubeSize: 0.192 },
    { aspect: 1.3, squircle: 8, colorOffset: [2.5, 4.5, 0.5], tubeSize: 0.256 },
];
const DWELL_MS = 3000;
const DURATION_MS = 1500;

const cubicInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a: number, b: number, n: number): number => a + (b - a) * n;
const lerpState = (a: MorphState, b: MorphState, n: number): MorphState => ({
    aspect: lerp(a.aspect, b.aspect, n),
    squircle: lerp(a.squircle, b.squircle, n),
    tubeSize: lerp(a.tubeSize, b.tubeSize, n),
    colorOffset: [lerp(a.colorOffset[0], b.colorOffset[0], n), lerp(a.colorOffset[1], b.colorOffset[1], n), lerp(a.colorOffset[2], b.colorOffset[2], n)],
});

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas);
    const engine = await createEngine(canvas, { maxDevicePixelRatio: 1 });

    const effect = createUniformEffectWrapper(engine, {
        name: "torus-states",
        fragmentWGSL: FRAGMENT_WGSL,
        uniformByteLength: 80,
    });
    const u = new Float32Array(20);
    const start = performance.now();
    let from = STATES[0]!;
    let to = STATES[0]!;
    let idx = 0;
    let transStart = -DURATION_MS;
    let lastSwitch = 0;

    const sourceTarget = createRenderTarget({
        lbl: "torus-states-source",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const outputTarget = engine.scRT;

    const context = createFrameGraphContext(engine, {
        name: "torus-states",
        update: () => {
            const now = performance.now();
            const elapsed = now - start;

            if (elapsed - lastSwitch >= DWELL_MS) {
                lastSwitch += DWELL_MS;
                from = lerpState(from, to, cubicInOut(Math.min(1, (now - transStart) / DURATION_MS)));
                idx = (idx + 1) % STATES.length;
                to = STATES[idx]!;
                transStart = now;
            }
            const s = lerpState(from, to, cubicInOut(Math.min(1, (now - transStart) / DURATION_MS)));

            u[0] = canvas.width;
            u[1] = canvas.height;
            u[2] = elapsed / 1000;
            u[3] = 1.0; // uAnimSpeed
            u[4] = s.colorOffset[0];
            u[5] = s.colorOffset[1];
            u[6] = s.colorOffset[2];
            u[7] = 3.0; // uFlowSpeed
            u[8] = 1.04; // uMajorR
            u[9] = s.tubeSize;
            u[10] = 2.0; // uTwistsPerRev
            u[11] = 8.0; // uStepDiv
            u[12] = s.aspect;
            u[13] = s.squircle;
            u[14] = 0.3; // uRotXSpeed
            u[15] = 0.0; // uRotYSpeed
            u[16] = 0.3; // uGlowStrength
            u[17] = 1.0; // uSpecStrength
            u[18] = 32.0; // uSpecPower
            u[19] = 0.5; // uFresnelStrength
            setUniformEffectUniforms(effect, u);
        },
    });
    addTask(
        context.frameGraph,
        createUniformEffectRenderTask(
            {
                name: "torus-states-source",
                effect,
                target: sourceTarget,
            },
            engine
        )
    );
    addTask(
        context.frameGraph,
        createBloomPostProcessTask(
            {
                name: "torus-states-bloom",
                sourceTexture: sourceTarget,
                targetTexture: outputTarget,
                threshold: 0.18,
                weight: 0.85,
                kernel: 32,
                bloomScale: 0.5,
            },
            engine
        )
    );

    registerFrameGraphContext(context);
    await startEngine(engine);
    progress.done();
    canvas.dataset.ready = "true";
}

void main().catch((err) => console.error(err));
