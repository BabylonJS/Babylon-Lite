Texture2D<float> g_ClipDepth;
Texture2D<float3> g_ClipNormal;

float3 DiligentHistoryGuideTap(int2 pixel, int2 offset, float3 position, float3 n, float3 nv, float tolerance)
{
    int2 q = ClampScreenCoord(pixel + offset, int2(g_CurrCamera.f4ViewportSize.xy));
    float d = g_ClipDepth.Load(int3(q, 0));
    if (IsBackground(d))
        return float3(0, 0, 0);
    float3 qn = normalize(g_ClipNormal.Load(int3(q, 0)));
    if (dot(n, qn) < 0.9)
        return float3(0, 0, 0);
    float3 qp = ScreenXYDepthToViewSpace(float3((float2(q) + 0.5) * g_CurrCamera.f4ViewportSize.zw, d), g_CurrCamera.mProj);
    float3 delta = qp - position;
    float distance = length(delta);
    float curvature = 0.5 * distance * length(qn - n);
    if (distance > 2 * g_SSAOAttribs.EffectRadius || abs(dot(delta, nv)) > tolerance + curvature)
        return float3(0, 0, 0);
    float value = LoadCurrOcclusion(q);
    return float3(value, value * value, 1);
}

float2 DiligentHistoryGuideStatistic(int2 pixel)
{
    float depth = g_ClipDepth.Load(int3(pixel, 0));
    if (IsBackground(depth))
    {
        return float2(LoadCurrOcclusion(pixel), 0);
    }
    float3 n = normalize(g_ClipNormal.Load(int3(pixel, 0)));
    float3 nv = normalize(mul(float4(n, 0), g_CurrCamera.mView).xyz);
    float3 position = ScreenXYDepthToViewSpace(float3((float2(pixel) + 0.5) * g_CurrCamera.f4ViewportSize.zw, depth), g_CurrCamera.mProj);
    float tolerance = max(1e-4, min(abs(position.z) * 0.005, g_SSAOAttribs.EffectRadius * 0.025));
    float3 sums = DiligentHistoryGuideTap(pixel, int2(-3,-3), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(0,-3), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(3,-3), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(-3,0), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(0,0), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(3,0), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(-3,3), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(0,3), position, n, nv, tolerance);
    sums += DiligentHistoryGuideTap(pixel, int2(3,3), position, n, nv, tolerance);
    float mean = sums.x / max(sums.z, 1);
    return float2(mean, max(0, sums.y / max(sums.z, 1) - mean * mean));
}
