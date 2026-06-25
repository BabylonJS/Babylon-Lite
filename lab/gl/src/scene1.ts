import { runFullscreenEffect } from "./_shared/run-effect";

runFullscreenEffect({
    name: "gl-scene1-gradient",
    fragmentSource: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
uniform vec2 uResolution;
void main() {
    vec3 col = 0.5 + 0.5 * cos(uTime + vUv.xyx + vec3(0.0, 2.0, 4.0));
    glFragColor = vec4(col, 1.0);
}`,
});
