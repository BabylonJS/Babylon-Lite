#version 430 core
#define float2 vec2
#define int2 ivec2
#define COMPUTE_BENT_NORMAL 0
const float PI = 3.14159265358979323846;
const float HALF_PI = 1.57079632679489661923;
const bool materialConstants_useVisibilityBitmasks = true;
const bool materialConstants_linearThickness = false;
float saturate(float v) { return clamp(v, 0.0, 1.0); }

struct Parameters {
    vec4 resolution;
    vec2 positionParams;
    float invFarPlane;
    int maxLevel;
    float projectionScaleRadius;
    float invRadiusSquared;
    float stepsPerSlice;
    vec2 sliceCount;
    float thicknessHeuristic;
    float constThickness;
};
uniform Parameters materialParams;
uniform sampler2D materialParams_depth;
uniform sampler2D normalInput;
uniform sampler2D deviceDepthInput;
layout(location=0) out float visibility;
highp float sampleDepthLinear(sampler2D source, vec2 uv, float level) {
    return textureLod(source, uv, level).r;
}
/* UPSTREAM */

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    if (texelFetch(deviceDepthInput, pixel, 0).r == 0.0) {
        visibility = 1.0;
        return;
    }
    vec2 uv = gl_FragCoord.xy * materialParams.resolution.zw;
    vec3 origin = getViewSpacePosition(uv, 0.0);
    vec3 normal = texelFetch(normalInput, pixel, 0).xyz;
    normal.z = -normal.z;
    float obscurance;
    vec3 bentNormal = vec3(0.0);
    groundTruthAmbientOcclusion(obscurance, bentNormal, uv, origin, normal);
    visibility = 1.0 - obscurance;
}
