import { runFullscreenEffect } from "./_shared/run-effect";

runFullscreenEffect({
    name: "gl-scene2-plasma",
    fragmentSource: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
uniform vec2 uResolution;
void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);
    float t = uTime;
    float v = sin(p.x * 8.0 + t) + sin(p.y * 8.0 + t * 1.3) + sin((p.x + p.y) * 8.0 + t) + sin(length(p) * 10.0 - t * 2.0);
    vec3 col = 0.5 + 0.5 * cos(vec3(v) + vec3(0.0, 2.0, 4.0));
    glFragColor = vec4(col, 1.0);
}`,
});
