import { runFullscreenEffect } from "./_shared/run-effect";

// scene7 — "Sine Wave Bands"
//
// Inspired by https://www.shadertoy.com/view/tffSDr — an original lite-gl
// reimplementation of the same generic effect (a stack of phase-shifted sine
// bands tinted by a cosine-gradient palette). The referenced source carried no
// license, so this is NOT a verbatim port: it is written from the underlying
// public techniques — Inigo Quilez's cosine palette `a + b*cos(2π(c*t+d))`
// (published free for reuse) and a textbook layered-sine field.
runFullscreenEffect({
    name: "gl-scene7-sine-bands",
    fragmentSource: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 glFragColor;
uniform float uTime;
uniform vec2 uResolution;

const float TAU = 6.28318530718;

// Cosine gradient palette (Inigo Quilez technique, free for reuse).
vec3 palette(float t) {
    return 0.5 + 0.5 * cos(TAU * (t + vec3(0.10, 0.40, 0.50)));
}

void main() {
    // Aspect-correct, centered coordinates (Y in [-1, 1]).
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    vec3 col = vec3(0.0);
    for (int i = 0; i < 10; i++) {
        float layer = float(i) * 0.1;
        float amp = 0.25 + 0.25 * sin(uTime + layer) * (1.0 - layer);
        float phase = uTime * (1.0 - layer);
        float thickness = 0.01 + 0.001 * pow(abs(uv.x), 8.0);
        float band = uv.y + amp * sin(2.0 * (uv.x - phase));
        float bright = smoothstep(0.0, 1.0, 1.0 - abs(band) / thickness);
        col += bright * palette(0.5 * uv.x + layer - 0.5 * uTime);
    }
    glFragColor = vec4(col, 1.0);
}`,
});
