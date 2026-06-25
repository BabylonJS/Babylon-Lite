import { runFullscreenEffect } from "../_shared/run-effect";

/**
 * Demo — "Just Another Cube" (Shadertoy 3XdXRr).
 *
 * A faithful lite-gl port of mrange's CC0 shader
 * (https://www.shadertoy.com/view/3XdXRr): a single-pass raymarched, twisting
 * superquadric ("rounded cube", an L8-norm SDF) with a volumetric glow,
 * fresnel-weighted reflections of a procedural sky/floor, and rim lighting — all
 * in a compact, code-golfed signed-distance field. Unlike the mandelbulb /
 * saturday-weirdness demos it needs NO render target: it is ONE fullscreen pass
 * rendered straight to the canvas (the lite-gl `runFullscreenEffect` path).
 *
 * Original shader: CC0 (public domain) by mrange. The GLSL below is adapted
 * essentially verbatim — the single-letter variable names are the original's
 * code-golf style. Two changes only: a thin lite-gl bridge maps Shadertoy's
 * implicit `iTime` / `iResolution` onto the helper's `uTime` / `uResolution`
 * uniforms, and three explicit initialisers (`z`, the normal-loop index `i`, and
 * the ray-miss colour `O`) replace the original's reliance on driver
 * zero-initialisation, so the result is correct on strict WebGL2 drivers.
 */
runFullscreenEffect({
    name: "gl-just-another-cube",
    fragmentSource: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
uniform vec2 uResolution;
// lite-gl bridge → Shadertoy's implicit uniforms (single pass: no iChannel0).
#define iTime uTime
#define iResolution vec3(uResolution, 1.0)

mat2 R;
float d = 1., z = 0., G = 9., M = 1e-3;

float D(vec3 p) {
  p.xy *= R;
  p.xz *= R;
  vec3 S = sin(123.*p);
  G = min(G, max(abs(length(p)-.6), d = pow(dot(p*=p*p*p,p),.125) - .5 - pow(1.+S.x*S.y*S.z,8.)/1e5));
  return d;
}

void mainImage(out vec4 o, vec2 C) {
  vec3 p, O = vec3(0.0), r = iResolution, I = normalize(vec3(C-.5*r.xy, r.y)), B = vec3(1,2,9)*M;
  for (R = mat2(cos(.3*iTime+vec4(0,11,33,0))); z<9. && d > M; z += D(p))
    p = z*I, p.z -= 2.;
  if (z < 9.) {
    for (int i = 0; i < 3; O[i++] = D(p+r) - D(p-r))
      r -= r, r[i] = M;
    z = 1.+dot(O = normalize(O), I);
    r = reflect(I, O);
    C = (p+r*(5.-p.y)/abs(r.y)).xz;
    O = z*z * (r.y>0. ? 5e2*smoothstep(5., 4., d = sqrt(length(C*C))+1.)*d*B : exp(-2.*length(C))*(B/M-1.)) + pow(1.+O.y,5.)*B;
  }
  o = sqrt(O+B/G).xyzx;
}

void main() {
  mainImage(glFragColor, vUv * uResolution);
}`,
});
