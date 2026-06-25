/**
 * Demo — "Inside the Mandelbulb II" (Shadertoy mtScRc).
 *
 * A faithful lite-gl port of mrange's CC0 shader
 * (https://www.shadertoy.com/view/mtScRc). The original is a two-pass Shadertoy:
 *   - Buffer A: a refraction/reflection-bouncing raymarch of a power-8 mandelbulb
 *     with a procedural sky + glow, ACES tonemapping and sRGB encode. It has NO
 *     channel inputs — it's fully self-contained (no frame feedback).
 *   - Image: an FXAA pass over Buffer A, presented to the screen.
 *
 * Reproduced here to exercise lite-gl's render-target (FBO) API on the SINGLE
 * render-target path (no ping-pong needed, since Buffer A reads nothing): Buffer A
 * renders into one offscreen render target, and the Image FXAA pass samples that
 * target and resolves it to the canvas.
 *
 * Original shader: CC0 (public domain) by mrange. The GLSL below is adapted
 * essentially verbatim with a thin lite-gl bridge (Shadertoy `mainImage` →
 * `glFragColor`; `iResolution`/`iTime`/`iChannel0` provided as uniforms).
 */
import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    drawEffect,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setEffectFloat,
    setEffectFloat3,
    setEffectTexture,
} from "babylon-lite-gl";
import { bindRenderTarget, createRenderTarget, resizeRenderTarget } from "babylon-lite-gl/render-target";

// ── Buffer A: mandelbulb raymarch (CC0, mrange — adapted verbatim) ───────────
const BUFFER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float iTime;
uniform vec3 iResolution;

#define LOOPS   2
#define POWER   8.0
#define ANIMATE

#define PI              3.141592654
#define TAU             (2.0*PI)
#define PHI             (sqrt(5.0)*0.5 + 0.5)

#define TIME            iTime
#define RESOLUTION      iResolution

#define TOLERANCE       0.0001
#define MAX_RAY_LENGTH  20.0
#define MAX_RAY_MARCHES 60
#define NORM_OFF        0.005
#define MAX_BOUNCES     5

mat3 g_rot  = mat3(1.0);

const vec4 hsv2rgb_K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www);
  return c.z * mix(hsv2rgb_K.xxx, clamp(p - hsv2rgb_K.xxx, 0.0, 1.0), c.y);
}
#define HSV2RGB(c)  (c.z * mix(hsv2rgb_K.xxx, clamp(abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www) - hsv2rgb_K.xxx, 0.0, 1.0), c.y))

const float hoff = 0.0;

const vec3 skyCol     = HSV2RGB(vec3(hoff+0.6, 0.86, 1.0));
const vec3 glowCol    = HSV2RGB(vec3(hoff+0.065, 0.8, 6.0));
const vec3 diffuseCol = HSV2RGB(vec3(hoff+0.6, 0.85, 1.0));
const vec3 lightPos   = vec3(0.0, 10.0, 0.0);
const vec3 mat        = vec3(0.8, 0.5, (1.+0.05));
const vec3 beer       = -HSV2RGB(vec3(0.05, 0.95, 2.0));
const float initt     = 0.1;

vec3 sRGB(vec3 t) {
  return mix(1.055*pow(t, vec3(1./2.4)) - 0.055, 12.92*t, step(t, vec3(0.0031308)));
}

vec3 aces_approx(vec3 v) {
  v = max(v, 0.0);
  v *= 0.6f;
  float a = 2.51f;
  float b = 0.03f;
  float c = 2.43f;
  float d = 0.59f;
  float e = 0.14f;
  return clamp((v*(a*v+b))/(v*(c*v+d)+e), 0.0f, 1.0f);
}

float box(vec2 p, vec2 b) {
  vec2 d = abs(p)-b;
  return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}

float rayPlane(vec3 ro, vec3 rd, vec4 p) {
  return -(dot(ro,p.xyz)+p.w)/dot(rd,p.xyz);
}

float mandelBulb(vec3 p) {
  const float power = POWER;
  vec3 z  = p;
  vec3 dz = vec3(0.0);
  float r, theta, phi;
  float dr = 1.0;

  for(int i = 0; i < LOOPS; ++i) {
    r = length(z);
    if(r > 2.0) continue;
    theta = atan(z.y, z.x);
#ifdef ANIMATE
    phi = asin(z.z / r) + TIME*0.2;
#else
    phi = asin(z.z / r);
#endif

    dr = pow(r, power - 1.0) * dr * power + 1.0;

    r = pow(r, power);
    theta = theta * power;
    phi = phi * power;

    z = r * vec3(cos(theta)*cos(phi), sin(theta)*cos(phi), sin(phi)) + p;
  }
  return 0.5 * log(r) * r / dr;
}

mat3 rot_z(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c,s,0, -s,c,0, 0,0,1);
}

mat3 rot_y(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c,0,s, 0,1,0, -s,0,c);
}

mat3 rot_x(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(1,0,0, 0,c,s, 0,-s,c);
}

vec3 skyColor(vec3 ro, vec3 rd) {
  vec3 col = clamp(vec3(0.0025/abs(rd.y))*skyCol, 0.0, 1.0);

  float tp0  = rayPlane(ro, rd, vec4(vec3(0.0, 1.0, 0.0), 4.0));
  float tp1  = rayPlane(ro, rd, vec4(vec3(0.0, -1.0, 0.0), 6.0));
  float tp = tp1;
  tp = max(tp0,tp1);

  if (tp1 > 0.0) {
    vec3 pos  = ro + tp1*rd;
    vec2 pp = pos.xz;
    float db = box(pp, vec2(6.0, 9.0))-1.0;

    col += vec3(4.0)*skyCol*rd.y*rd.y*smoothstep(0.25, 0.0, db);
    col += vec3(0.8)*skyCol*exp(-0.5*max(db, 0.0));
  }

  if (tp0 > 0.0) {
    vec3 pos  = ro + tp0*rd;
    vec2 pp = pos.xz;
    float ds = length(pp) - 0.5;

    col += vec3(0.25)*skyCol*exp(-.5*max(ds, 0.0));
  }

  return clamp(col, 0.0, 10.0);
}

float df(vec3 p) {
  p *= g_rot;
  const float z1 = 2.0;
  return mandelBulb(p/z1)*z1;
}

vec3 normal(vec3 pos) {
  vec2  eps = vec2(NORM_OFF,0.0);
  vec3 nor;
  nor.x = df(pos+eps.xyy) - df(pos-eps.xyy);
  nor.y = df(pos+eps.yxy) - df(pos-eps.yxy);
  nor.z = df(pos+eps.yyx) - df(pos-eps.yyx);
  return normalize(nor);
}

float rayMarch(vec3 ro, vec3 rd, float dfactor, out int ii) {
  float t = 0.0;
  float tol = dfactor*TOLERANCE;
  ii = MAX_RAY_MARCHES;
  for (int i = 0; i < MAX_RAY_MARCHES; ++i) {
    if (t > MAX_RAY_LENGTH) {
      t = MAX_RAY_LENGTH;
      break;
    }
    float d = dfactor*df(ro + rd*t);
    if (d < TOLERANCE) {
      ii = i;
      break;
    }
    t += d;
  }
  return t;
}

vec3 render(vec3 ro, vec3 rd) {
  vec3 agg = vec3(0.0, 0.0, 0.0);
  vec3 ragg = vec3(1.0);

  bool isInside = df(ro) < 0.0;

  for (int bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
    float dfactor = isInside ? -1.0 : 1.0;
    float mragg = max(max(ragg.x, ragg.y), ragg.z);
    if (mragg < 0.025) break;
    int iter;
    float st = rayMarch(ro, rd, dfactor, iter);
    const float mrm = 1.0/float(MAX_RAY_MARCHES);
    float ii = float(iter)*mrm;
    if (st >= MAX_RAY_LENGTH) {
      agg += ragg*skyColor(ro, rd);
      break;
    }

    vec3 sp = ro+rd*st;

    vec3 sn = dfactor*normal(sp);
    float fre = 1.0+dot(rd, sn);
    fre *= fre;
    fre = mix(0.1, 1.0, fre);

    vec3 ld     = normalize(lightPos - sp);

    float dif   = max(dot(ld, sn), 0.0);
    vec3 ref    = reflect(rd, sn);
    float re    = mat.z;
    float ire   = 1.0/re;
    vec3 refr   = refract(rd, sn, !isInside ? re : ire);
    vec3 rsky   = skyColor(sp, ref);
    vec3 col = vec3(0.0);
    col += diffuseCol*dif*dif*(1.0-mat.x);
    float edge = smoothstep(1.0, 0.9, fre);
    col += rsky*mat.y*fre*vec3(1.0)*edge;
    if (isInside) {
      ragg *= exp(-(st+initt)*beer);
    }
    agg += ragg*col;

    if (refr == vec3(0.0)) {
      rd = ref;
    } else {
      ragg *= mat.x;
      isInside = !isInside;
      rd = refr;
    }

    ro = sp+initt*rd;
  }

  return agg;
}

vec3 effect(vec2 p) {
  g_rot = rot_x(0.2*TIME)*rot_y(0.3*TIME);
  vec3 ro = 0.6*vec3(0.0, 2.0, 5.0);
  const vec3 la = vec3(0.0, 0.0, 0.0);
  const vec3 up = vec3(0.0, 1.0, 0.0);

  vec3 ww = normalize(la - ro);
  vec3 uu = normalize(cross(up, ww ));
  vec3 vv = (cross(ww,uu));
  const float fov = tan(TAU/6.);
  vec3 rd = normalize(-p.x*uu + p.y*vv + fov*ww);

  vec3 col = render(ro, rd);

  return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/RESOLUTION.xy;
  vec2 p = -1. + 2. * q;
  p.x *= RESOLUTION.x/RESOLUTION.y;
  vec3 col = vec3(0.0);
  col = effect(p);
  col = aces_approx(col);
  col = sRGB(col);
  fragColor = vec4(col, 1.0);
}

void main() {
  vec2 fragCoord = vUv * iResolution.xy;
  mainImage(glFragColor, fragCoord);
}`;

// ── Image: FXAA resolve to screen (CC0, mrange / XorDev — adapted verbatim) ──
const IMAGE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
#define RESOLUTION iResolution

vec4 fxaa(sampler2D tex, vec2 uv, vec2 texelSz) {
  const float span_max    = 8.0;
  const float reduce_min  = (1.0/128.0);
  const float reduce_mul  = (1.0/32.0);
  const vec3  luma        = vec3(0.299, 0.587, 0.114);
  vec3 rgbCC = texture(tex, uv).rgb;
  vec3 rgb00 = texture(tex, uv+vec2(-0.5,-0.5)*texelSz).rgb;
  vec3 rgb10 = texture(tex, uv+vec2(+0.5,-0.5)*texelSz).rgb;
  vec3 rgb01 = texture(tex, uv+vec2(-0.5,+0.5)*texelSz).rgb;
  vec3 rgb11 = texture(tex, uv+vec2(+0.5,+0.5)*texelSz).rgb;
  float lumaCC = dot(rgbCC, luma);
  float luma00 = dot(rgb00, luma);
  float luma10 = dot(rgb10, luma);
  float luma01 = dot(rgb01, luma);
  float luma11 = dot(rgb11, luma);
  vec2 dir = vec2((luma01 + luma11) - (luma00 + luma10), (luma00 + luma01) - (luma10 + luma11));
  float dirReduce = max((luma00 + luma10 + luma01 + luma11) * reduce_mul, reduce_min);
  float rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDir, -span_max, span_max) * texelSz.xy;
  vec4 A = 0.5 * (
      texture(tex, uv - dir * (1.0/6.0))
    + texture(tex, uv + dir * (1.0/6.0))
    );
  vec4 B = A * 0.5 + 0.25 * (
      texture(tex, uv - dir * (0.5))
    + texture(tex, uv + dir * (0.5))
    );
  float lumaMin = min(lumaCC, min(min(luma00, luma10), min(luma01, luma11)));
  float lumaMax = max(lumaCC, max(max(luma00, luma10), max(luma01, luma11)));
  float lumaB = dot(B.rgb, luma);
  return ((lumaB < lumaMin) || (lumaB > lumaMax)) ? A : B;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/RESOLUTION.xy;
  fragColor = fxaa(iChannel0, q, sqrt(2.0)/RESOLUTION.xy);
}

void main() {
  vec2 fragCoord = vUv * iResolution.xy;
  mainImage(glFragColor, fragCoord);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

// The power-8 mandelbulb raymarch (Buffer A) is by far the most expensive pass,
// so its offscreen resolution is CAPPED to MAX_RT_SIZE on the longest side
// (aspect preserved). This bounds the raymarch cost independent of the canvas /
// display (e.g. retina) size; the cheap FXAA pass then upscales the result to the
// canvas.
const MAX_RT_SIZE = 1024;

/** Cap (w, h) so its longest side is ≤ MAX_RT_SIZE, preserving aspect ratio. */
function cappedRtSize(w: number, h: number): { w: number; h: number } {
    const scale = Math.min(1, MAX_RT_SIZE / Math.max(w, h, 1));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// Buffer A renders the mandelbulb into a single offscreen target (RGBA8, LINEAR
// so the FXAA pass can sample it smoothly). No depth, no ping-pong — Buffer A
// reads nothing, so one render target is enough.
const initRt = cappedRtSize(canvas.width || 1, canvas.height || 1);
const rt = createRenderTarget(engine, { width: initRt.w, height: initRt.h });
let rtW = initRt.w;
let rtH = initRt.h;

const bufferWrapper = createEffectWrapper(engine, {
    name: "gl-mandelbulb-buffer",
    fragmentSource: BUFFER_FRAGMENT,
    uniformNames: ["iTime", "iResolution"],
});
const bufferEffect = bufferWrapper.effect;

const imageWrapper = createEffectWrapper(engine, {
    name: "gl-mandelbulb-image",
    fragmentSource: IMAGE_FRAGMENT,
    uniformNames: ["iResolution"],
    samplerNames: ["iChannel0"],
});
const imageEffect = imageWrapper.effect;

const initStart = performance.now();
const startMs = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, bufferEffect) || !isEffectReady(engine, imageEffect)) {
        return;
    }
    resizeGLEngine(engine);
    // Buffer A renders at the CAPPED resolution; the FXAA pass upscales to canvas.
    const target = cappedRtSize(canvas.width, canvas.height);
    if (target.w !== rtW || target.h !== rtH) {
        resizeRenderTarget(engine, rt, target.w, target.h);
        rtW = target.w;
        rtH = target.h;
    }

    const time = (performance.now() - startMs) / 1000;

    // Pass 1 — Buffer A: raymarch the mandelbulb into the (capped) render target.
    bindRenderTarget(engine, rt);
    applyEffectWrapper(bufferWrapper);
    setEffectFloat(engine, bufferEffect, "iTime", time);
    setEffectFloat3(engine, bufferEffect, "iResolution", rtW, rtH, 1);
    drawEffect(engine);

    // Pass 2 — Image: FXAA-resolve Buffer A (at its capped resolution) to the
    // full-size canvas. iResolution is the render-target size so the FXAA texel
    // offsets land on adjacent Buffer-A texels.
    bindRenderTarget(engine, null);
    applyEffectWrapper(imageWrapper);
    setEffectFloat3(engine, imageEffect, "iResolution", rtW, rtH, 1);
    setEffectTexture(engine, imageEffect, "iChannel0", rt.texture);
    drawEffect(engine);

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "2";
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.rtSize = `${rtW}x${rtH}`;
        canvas.dataset.ready = "true";
    }
});
