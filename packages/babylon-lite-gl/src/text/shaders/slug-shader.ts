/** Analytic SLUG coverage, matching Lite's WGSL template. Original algorithm:
 * https://github.com/EricLengyel/Slug. Metadata/styles use lookup textures on GL. */
import type { TextShaderFragment } from "./text-shader-fragment.js";

/** @internal */
export interface ComposedSlugShader {
    /** @internal */
    readonly _vert: string;
    /** @internal */
    readonly _frag: string;
    /** @internal */
    readonly _key: string;
}

/** @internal Direct interpolation remains valid after production shader minification. */
export function composeSlugShader(fragment: TextShaderFragment | null): ComposedSlugShader {
    const v = fragment?._vertexSlots;
    const f = fragment?._fragmentSlots;
    const bounds = v?.VB ? "sb" : "bounds";
    return {
        _key: fragment?._id ?? "",
        _vert: `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location=0) in vec2 corner;
layout(location=1) in vec2 anchor;
layout(location=2) in uint glyphStyle;
uniform mat4 mvp;
uniform vec4 viewport;
uniform vec4 color;
uniform sampler2D glyphMetadata;
uniform sampler2D styles;
out vec2 texcoord;
flat out vec4 banding;
flat out vec4 glyph;
flat out vec4 glyphColor;
${v?.VO ?? ""}
vec4 tableFetch(sampler2D table, uint offset) {
    return texelFetch(table, ivec2(int(offset & 255u), int(offset >> 8u)), 0);
}
void main() {
    if (glyphStyle == 0xffffffffu) {
        gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
        texcoord = vec2(0.0);
        banding = vec4(0.0);
        glyph = vec4(0.0);
        glyphColor = vec4(0.0);
        ${v?.VD ?? ""}
        return;
    }
    uint mi = (glyphStyle & 0xffffu) * 3u;
    uint si = (glyphStyle >> 16u) * 2u;
    vec4 bounds = tableFetch(glyphMetadata, mi);
    vec4 styleColor = tableFetch(styles, si);
    vec4 params = tableFetch(styles, si + 1u);
    ${v?.VB ?? ""}
    vec2 tx = mix(${bounds}.xy, ${bounds}.zw, step(vec2(0.0), corner));
    float iv = params.x;
    float scale = iv != 0.0 ? 1.0 / iv : 0.0;
    vec2 pos = anchor + tx * scale;
    vec3 r0 = vec3(mvp[0].x, mvp[1].x, mvp[3].x);
    vec3 r1 = vec3(mvp[0].y, mvp[1].y, mvp[3].y);
    vec3 r3 = vec3(mvp[0].w, mvp[1].w, mvp[3].w);
    vec2 n = normalize(corner);
    float s = dot(r3.xy, pos) + r3.z;
    float t = dot(r3.xy, n);
    float u = (s * dot(r0.xy, n) - t * (dot(r0.xy, pos) + r0.z)) * viewport.x;
    float v = (s * dot(r1.xy, n) - t * (dot(r1.xy, pos) + r1.z)) * viewport.y;
    float uv = u * u + v * v;
    float q = s * t;
    vec2 dilation = corner * (s * s * (q + sqrt(uv)) / (uv - q * q));
    gl_Position = mvp * vec4(pos + dilation, 0.0, 1.0);
    texcoord = tx + dilation * iv;
    glyph = tableFetch(glyphMetadata, mi + 1u);
    banding = tableFetch(glyphMetadata, mi + 2u);
    glyphColor = vec4(styleColor.rgb, styleColor.a * color.a);
    ${v?.VA ?? ""}
}`,
        _frag: `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform sampler2D curveTex;
uniform usampler2D bandTex;
uniform vec4 color;
in vec2 texcoord;
flat in vec4 banding;
flat in vec4 glyph;
flat in vec4 glyphColor;
${f?.FI ?? ""}
out vec4 fragmentColor;
int rootCode(float y1, float y2, float y3) {
    int s = (y1 < 0.0 ? 1 : 0) + (y2 < 0.0 ? 2 : 0) + (y3 < 0.0 ? 4 : 0);
    return (0x2E74 >> s) & 0x0101;
}
vec2 solveHorizontal(vec4 p12, vec2 p3) {
    vec2 a = p12.xy - 2.0 * p12.zw + p3;
    vec2 b = p12.xy - p12.zw;
    float ra = 1.0 / a.y;
    float rb = 0.5 / b.y;
    float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
    float t1 = (b.y - d) * ra;
    float t2 = (b.y + d) * ra;
    if (abs(a.y) <= max(abs(b.y), abs(p12.y)) * 1.0e-4) {
        t1 = p12.y * rb;
        t2 = p12.y * rb;
    }
    return vec2((a.x * t1 - 2.0 * b.x) * t1 + p12.x, (a.x * t2 - 2.0 * b.x) * t2 + p12.x);
}
vec2 solveVertical(vec4 p12, vec2 p3) {
    vec2 a = p12.xy - 2.0 * p12.zw + p3;
    vec2 b = p12.xy - p12.zw;
    float ra = 1.0 / a.x;
    float rb = 0.5 / b.x;
    float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
    float t1 = (b.x - d) * ra;
    float t2 = (b.x + d) * ra;
    if (abs(a.x) <= max(abs(b.x), abs(p12.x)) * 1.0e-4) {
        t1 = p12.x * rb;
        t2 = p12.x * rb;
    }
    return vec2((a.y * t1 - 2.0 * b.y) * t1 + p12.y, (a.y * t2 - 2.0 * b.y) * t2 + p12.y);
}
float crossingCoverage(float r) { return clamp(r + 0.5, 0.0, 1.0); }
float crossingWeight(float r) { return clamp(1.0 - abs(r) * 2.0, 0.0, 1.0); }
ivec2 bandLocation(ivec2 origin, int offset) {
    int x = origin.x + offset;
    return ivec2(x & 4095, origin.y + (x >> 12));
}
${f?.FH ?? ""}
void main() {
    if (!gl_FrontFacing) { discard; }
    vec2 rc = texcoord;
    vec2 pe = 1.0 / fwidth(rc);
    ivec2 gp = ivec2(glyph.xy + 0.5);
    ivec2 bm = ivec2(glyph.zw + 0.5);
    ivec2 bi = clamp(ivec2(rc * banding.xy + banding.zw), ivec2(0), bm);
    float xc = 0.0;
    float xw = 0.0;
    float yc = 0.0;
    float yw = 0.0;
    uvec4 hr = texelFetch(bandTex, ivec2(gp.x + bi.y, gp.y), 0);
    int hn = int(hr.x);
    ivec2 hl = bandLocation(gp, int(hr.y));
    for (int i = 0; i < hn; i++) {
        ivec2 cv = ivec2(texelFetch(bandTex, bandLocation(hl, i), 0).xy);
        vec4 p12 = texelFetch(curveTex, cv, 0) - vec4(rc, rc);
        vec2 p3 = texelFetch(curveTex, ivec2(cv.x + 1, cv.y), 0).xy - rc;
        if (max(max(p12.x, p12.z), p3.x) * pe.x < -0.5) { break; }
        int code = rootCode(p12.y, p12.w, p3.y);
        if (code != 0) {
            vec2 r = solveHorizontal(p12, p3) * pe.x;
            if ((code & 1) != 0) {
                xc += crossingCoverage(r.x);
                xw = max(xw, crossingWeight(r.x));
            }
            if (code > 1) {
                xc -= crossingCoverage(r.y);
                xw = max(xw, crossingWeight(r.y));
            }
        }
    }
    uvec4 vr = texelFetch(bandTex, ivec2(gp.x + bm.y + 1 + bi.x, gp.y), 0);
    int vn = int(vr.x);
    ivec2 vl = bandLocation(gp, int(vr.y));
    for (int i = 0; i < vn; i++) {
        ivec2 cv = ivec2(texelFetch(bandTex, bandLocation(vl, i), 0).xy);
        vec4 p12 = texelFetch(curveTex, cv, 0) - vec4(rc, rc);
        vec2 p3 = texelFetch(curveTex, ivec2(cv.x + 1, cv.y), 0).xy - rc;
        if (max(max(p12.y, p12.w), p3.y) * pe.y < -0.5) { break; }
        int code = rootCode(p12.x, p12.z, p3.x);
        if (code != 0) {
            vec2 r = solveVertical(p12, p3) * pe.y;
            if ((code & 1) != 0) {
                yc -= crossingCoverage(r.x);
                yw = max(yw, crossingWeight(r.x));
            }
            if (code > 1) {
                yc += crossingCoverage(r.y);
                yw = max(yw, crossingWeight(r.y));
            }
        }
    }
    float coverage = max(abs(xc * xw + yc * yw) / max(xw + yw, 1.0 / 65536.0), min(abs(xc), abs(yc)));
    coverage = clamp(coverage, 0.0, 1.0);
    ${f?.CO ?? ""}
    coverage = pow(coverage, color.x);
    float alpha = glyphColor.a * coverage;
    fragmentColor = vec4(glyphColor.rgb * alpha, alpha);
}`,
    };
}
