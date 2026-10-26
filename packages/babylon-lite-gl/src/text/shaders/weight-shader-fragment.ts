import type { TextShaderFragment } from "./text-shader-fragment.js";

/** @internal GLSL counterpart of Lite's opt-in, radius-bounded contour-distance scan. */
export const WEIGHT_SHADER_FRAGMENT: TextShaderFragment = {
    _id: "w",
    _vertexSlots: {
        VO: "flat out float weightOffset;",
        VD: "weightOffset = 0.0;",
        VB: "float wo = params.y;\nvec4 sb = vec4(bounds.xy - vec2(wo), bounds.zw + vec2(wo));",
        VA: "weightOffset = wo;",
    },
    _fragmentSlots: {
        FI: "flat in float weightOffset;",
        FH: `float dot2(vec2 v) { return dot(v, v); }
float quadraticDistance(vec2 p, vec2 A, vec2 B, vec2 C) {
    vec2 a = B - A;
    vec2 b = A - 2.0 * B + C;
    vec2 c = a * 2.0;
    vec2 d = A - p;
    float bb = dot(b, b);
    if (bb < 1.0e-7) {
        vec2 ba = C - A;
        float t = clamp(dot(p - A, ba) / max(dot(ba, ba), 1.0e-9), 0.0, 1.0);
        return length(A + ba * t - p);
    }
    float kk = 1.0 / bb;
    float kx = kk * dot(a, b);
    float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
    float kz = kk * dot(d, a);
    float pp = ky - kx * kx;
    float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
    float h = q * q + 4.0 * pp * pp * pp;
    float result;
    if (h >= 0.0) {
        float hh = sqrt(h);
        vec2 x = (vec2(hh, -hh) - q) / 2.0;
        vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
        float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
        result = dot2(d + (c + b * t) * t);
    } else {
        float z = sqrt(-pp);
        float v = acos(q / (pp * z * 2.0)) / 3.0;
        float m = cos(v);
        float n = sin(v) * 1.732050808;
        vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, vec3(0.0), vec3(1.0));
        result = min(dot2(d + (c + b * t.x) * t.x), dot2(d + (c + b * t.y) * t.y));
    }
    return sqrt(result);
}
// The coverage walk cannot be reused: nearby contours can lie in adjacent bands or behind its early exit.
float weightDistance(vec2 rc, ivec2 gp, ivec2 bm, vec4 bn, float radius) {
    int y0 = clamp(int((rc.y - radius) * bn.y + bn.w), 0, bm.y);
    int y1 = clamp(int((rc.y + radius) * bn.y + bn.w), 0, bm.y);
    float left = rc.x - radius;
    float nearest = 1.0e9;
    for (int band = y0; band <= y1; band++) {
        uvec4 header = texelFetch(bandTex, ivec2(gp.x + band, gp.y), 0);
        int count = int(header.x);
        ivec2 list = bandLocation(gp, int(header.y));
        for (int i = 0; i < count; i++) {
            ivec2 cv = ivec2(texelFetch(bandTex, bandLocation(list, i), 0).xy);
            vec4 q12 = texelFetch(curveTex, cv, 0);
            vec2 q3 = texelFetch(curveTex, ivec2(cv.x + 1, cv.y), 0).xy;
            if (max(max(q12.x, q12.z), q3.x) < left) { break; }
            nearest = min(nearest, quadraticDistance(rc, q12.xy, q12.zw, q3));
        }
    }
    return nearest;
}`,
        CO: `if (weightOffset != 0.0) {
    float aaScale = max(max(pe.x, pe.y), 1.0e-8);
    float distance = weightDistance(rc, gp, bm, banding, weightOffset + 1.0 / aaScale);
    coverage = max(coverage, clamp((weightOffset - distance) * aaScale + 0.5, 0.0, 1.0));
}`,
    },
};
