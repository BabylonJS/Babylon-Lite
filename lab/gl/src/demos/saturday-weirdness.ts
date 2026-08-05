/**
 * Demo — "Saturday weirdness" (Shadertoy 43jXWt).
 *
 * A faithful lite-gl port of mrange's CC0 shader
 * (https://www.shadertoy.com/view/43jXWt). The original is a multi-pass
 * Shadertoy with frame feedback:
 *   - Buffer A: a raymarched rotating `sphere4` lit by two point lights + a sun,
 *     with glow planes, reflections and ACES tonemapping, PLUS a self-feedback
 *     term that samples Buffer A's OWN previous frame (`texture(iChannel0, tp)`)
 *     — this recursive surface texture is the signature "weirdness".
 *   - Image: an FXAA pass over Buffer A, presented to the screen.
 *
 * This is reproduced here to exercise lite-gl's render-target (FBO) API via a
 * ping-pong feedback pair (a lab helper). Buffer A renders into the pair's `write`
 * target (reading the previous frame as `iChannel0`); the Image pass FXAA-resolves
 * it to the canvas.
 *
 * Original shader: CC0 (public domain) by mrange. The GLSL below is adapted
 * essentially verbatim with a thin lite-gl bridge (Shadertoy `mainImage` →
 * `glFragColor`, `iResolution`/`iTime`/`iChannel0` provided as uniforms).
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
    bindRenderTarget,
} from "babylon-lite-gl";
import { createPingPong } from "../ping-pong";

// ── Shadertoy "common" tab (defines shared by both passes) ──────────────────
const COMMON = `
#define TIME        iTime
#define RESOLUTION  iResolution
#define PI          3.141592654
#define TAU         (2.0*PI)
#define ROT(a)      mat2(cos(a), sin(a), -sin(a), cos(a))
`;

// ── Buffer A: raymarch + self-feedback (CC0, mrange — adapted verbatim) ──────
const BUFFER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float iTime;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
${COMMON}
const vec4 hsv2rgb_K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www);
  return c.z * mix(hsv2rgb_K.xxx, clamp(p - hsv2rgb_K.xxx, 0.0, 1.0), c.y);
}
#define HSV2RGB(c)  (c.z * mix(hsv2rgb_K.xxx, clamp(abs(fract(c.xxx + hsv2rgb_K.xyz) * 6.0 - hsv2rgb_K.www) - hsv2rgb_K.xxx, 0.0, 1.0), c.y))

#define TOLERANCE           0.0001
#define MAX_RAY_LENGTH      10.0
#define MAX_RAY_MARCHES     80
#define NORM_OFF            0.005

const vec3 sunCol    = HSV2RGB(vec3(0.6, 0.95, 1E-2));
const vec3 sunDir    = normalize(vec3(0.,0., 1.));

const vec3 lightCol0 = HSV2RGB(vec3(0.7, 0.85, 1.0));
const vec3 lightPos0 = 4.0*vec3(1.0, 1.0, -2.0);

const vec3 lightCol1 = HSV2RGB(vec3(0.8, 0.75, 1.0));
const vec3 lightPos1 = 2.0*vec3(-1.0, -1.0, -2.0);

const vec3 bottomBoxCol = HSV2RGB(vec3(0.7, 0.80, 0.5));
const vec3 topBoxCol    = HSV2RGB(vec3(0.57, 0.90, 1.));

mat3 rot(vec3 d, vec3 z) {
  vec3  v = cross( z, d );
  float c = dot( z, d );
  float k = 1.0/(1.0+c);
  return mat3( v.x*v.x*k + c,     v.y*v.x*k - v.z,    v.z*v.x*k + v.y,
               v.x*v.y*k + v.z,   v.y*v.y*k + c,      v.z*v.y*k - v.x,
               v.x*v.z*k - v.y,   v.y*v.z*k + v.x,    v.z*v.z*k + c    );
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

float rayPlane(vec3 ro, vec3 rd, vec4 p) {
  return -(dot(ro,p.xyz)+p.w)/dot(rd,p.xyz);
}

float box(vec2 p, vec2 b) {
  vec2 d = abs(p)-b;
  return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}

mat3 g_rot;

float sphere4(vec3 p, float r) {
  p*=p;
  return pow(dot(p,p), 0.25) -r;
}

float df(vec3 p) {
  vec3 op = p;
  p *= g_rot;
  return sphere4(p, 1.);
}

#define BACKSTEP
float rayMarch(vec3 ro, vec3 rd, float tinit, out int iter) {
  float t = tinit;
  const float tol = TOLERANCE;
#if defined(BACKSTEP)
  vec2 dti = vec2(1e10,0.0);
#endif
  int i = 0;
  for (i = 0; i < MAX_RAY_MARCHES; ++i) {
    float d = df(ro + rd*t);
#if defined(BACKSTEP)
    if (d<dti.x) { dti=vec2(d,t); }
#endif
    if (d < TOLERANCE || t > MAX_RAY_LENGTH) {
      break;
    }
    t += d;
  }
#if defined(BACKSTEP)
  if(i==MAX_RAY_MARCHES) { t=dti.y; };
#endif
  iter = i;
  return t;
}

vec3 normal(vec3 pos) {
  vec2  eps = vec2(NORM_OFF,0.0);
  vec3 nor;
  nor.x = df(pos+eps.xyy) - df(pos-eps.xyy);
  nor.y = df(pos+eps.yxy) - df(pos-eps.yxy);
  nor.z = df(pos+eps.yyx) - df(pos-eps.yyx);
  return normalize(nor);
}

vec3 render0(vec3 ro, vec3 rd) {
  vec3 col = vec3(0.0);
  vec3 ld0 = normalize(lightPos0-ro);
  vec3 ld1 = normalize(lightPos1-ro);
  float tp0  = rayPlane(ro, rd, vec4(vec3(0.0, -1.0, 0.0), -5.0));
  float tp1  = rayPlane(ro, rd, vec4(vec3(0.0, -1.0, 0.0), 6.0));
  if (tp0 > 0.0) {
    col += bottomBoxCol*exp(-0.5*(length((ro + tp0*rd).xz)));
  }
  if (tp1 > 0.0) {
    vec3 pos  = ro + tp1*rd;
    vec2 pp = pos.xz;
    float db = box(pp, vec2(5.0, 9.0))-3.0;
    col += topBoxCol*rd.y*rd.y*smoothstep(0.25, 0.0, db);
    col += 0.2*topBoxCol*exp(-0.5*max(db, 0.0));
    col += 0.05*sqrt(topBoxCol)*max(-db, 0.0);
  }
  col += 1E-2*lightCol0/(1.002-dot(ld0, rd));
  col += 2E-2*lightCol1/(1.005-dot(ld1, rd));
  col += sunCol/(1.001-dot(sunDir, rd));
  return col;
}

vec3 render1(vec3 ro, vec3 rd) {
  int ii;
  float t = rayMarch(ro, rd, 0., ii);
  vec3 col = render0(ro, rd);
  if (t < MAX_RAY_LENGTH) {
    vec3 p = ro+rd*t;
    vec3 n = normal(p);
    vec3 r = reflect(rd, n);
    vec3 rcol = render0(p, r);
    float fre = 1.0+dot(rd,n);
    fre *= fre;
    fre = mix(0.5, 1.0, fre);
    vec3 ld0 = normalize(lightPos0-p);
    vec3 ld1 = normalize(lightPos1-p);
    float dif0 = pow(max(dot(ld0, n), 0.), 4.0)*0.5;
    float dif1 = pow(max(dot(ld1, n), 0.), 4.0)*0.5;
    col = vec3(0.);
    col += dif0*lightCol0;
    col += dif1*lightCol1;
    col += rcol*fre;
    vec2 p2 = p.xy*n.z+p.xz*n.y+p.zy*n.x;
    p2 *= 1.-0.3;
    p2 *= ROT(-20.*length(p2));
    p2.x *= RESOLUTION.y/RESOLUTION.x;
    vec2 tp = 0.5+0.5*p2;
    vec4 pcol = texture(iChannel0, tp);
    col += smoothstep(vec3(0.2, 0.25, 0.5), vec3(1.75, 1.6, 1.4), pcol.xyz);
  }
  return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/RESOLUTION.xy;
  vec2 p = -1. + 2. * q;
  p.x *= RESOLUTION.x/RESOLUTION.y;
  float a = TIME*0.25;
  vec3 r0 = vec3(1.0, sin(vec2(sqrt(0.5), 1.0)*a));
  vec3 r1 = vec3(cos(vec2(sqrt(0.5), 1.0)*a), 1.0);
  g_rot = rot(normalize(r0), normalize(r1));
  const vec3 up = vec3(0., 1., 0.);
  vec3 ro   = vec3(0.0, 0.5, -3.0);
  vec3 la   = vec3(0.0);
  vec3 ww = normalize(la-ro);
  vec3 uu = normalize(cross(up, ww));
  vec3 vv = cross(ww, uu);
  vec3 rd = normalize(p.x*uu + p.y*vv + 2.*ww);
  vec3 col = vec3(0.0);
  col = render1(ro, rd);
  col -= 4E-2*vec3(1.,2.,3.).zyx*(length(p)+0.25);
  col = aces_approx(col);
  col = sqrt(col);
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
#define FXAA

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
  vec2 isz = 1./RESOLUTION.xy;
  vec2 q = fragCoord*isz;
#ifdef FXAA
  fragColor = fxaa(iChannel0, q, sqrt(2.)*isz);
#else
  fragColor = texture(iChannel0, q);
#endif
}

void main() {
  vec2 fragCoord = vUv * iResolution.xy;
  mainImage(glFragColor, fragCoord);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;

// Buffer A renders into a ping-pong render target so it can sample its own
// previous frame as iChannel0. RGBA8 is sufficient: Buffer A's output is already
// ACES-tonemapped + gamma-encoded into [0,1]. REPEAT + LINEAR mirror Shadertoy's
// default buffer-channel sampling (the feedback UV `tp` can leave [0,1]).
const pingpong = createPingPong(engine, {
    width: canvas.width || 1,
    height: canvas.height || 1,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
});
let rtW = canvas.width || 1;
let rtH = canvas.height || 1;

const bufferWrapper = createEffectWrapper(engine, {
    name: "gl-saturday-buffer",
    fragmentSource: BUFFER_FRAGMENT,
    uniformNames: ["iTime", "iResolution"],
    samplerNames: ["iChannel0"],
});
const bufferEffect = bufferWrapper.effect;

const imageWrapper = createEffectWrapper(engine, {
    name: "gl-saturday-image",
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
    const w = canvas.width;
    const h = canvas.height;
    if (w !== rtW || h !== rtH) {
        pingpong.resize(w, h);
        rtW = w;
        rtH = h;
    }

    const time = (performance.now() - startMs) / 1000;

    // Pass 1 — Buffer A: render into `write`, sampling the previous frame (`read`).
    bindRenderTarget(engine, pingpong.write);
    applyEffectWrapper(bufferWrapper);
    setEffectFloat(engine, bufferEffect, "iTime", time);
    setEffectFloat3(engine, bufferEffect, "iResolution", w, h, 1);
    setEffectTexture(engine, bufferEffect, "iChannel0", pingpong.read.texture);
    drawEffect(engine);

    // Pass 2 — Image: FXAA-resolve the Buffer A we just produced to the screen.
    bindRenderTarget(engine, null);
    applyEffectWrapper(imageWrapper);
    setEffectFloat3(engine, imageEffect, "iResolution", w, h, 1);
    setEffectTexture(engine, imageEffect, "iChannel0", pingpong.write.texture);
    drawEffect(engine);

    // Swap so next frame reads the buffer we just wrote (the feedback chain).
    pingpong.swap();

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = "2";
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
    }
});
