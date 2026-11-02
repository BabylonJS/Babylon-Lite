#include "BasicStructures.fxh"
#include "FullScreenTriangleVSOutput.fxh"
#include "PostFX_Common.fxh"

cbuffer cbCameraAttribs
{
    CameraAttribs g_Camera;
}

Texture2D<float> g_TextureDepth;

float4 DiagnosticPS(in FullScreenTriangleVSOutput input) : SV_Target0
{
    float depth = g_TextureDepth.Load(int3(int2(input.f4PixelPos.xy), 0));
    if (depth == 0.0)
        return float4(0, 0, 0, 0);
    float3 position = InvProjectPosition(float3(input.f4PixelPos.xy * g_Camera.f4ViewportSize.zw, depth), g_Camera.mViewProjInv);
    return float4(position, 1);
}
