#define XE_GTAO_USE_HALF_FLOAT_PRECISION 0
#define XE_GTAO_FP32_DEPTHS
#define VA_SATURATE saturate
/* UPSTREAM */

cbuffer Constants : register(b0) { GTAOConstants settings; }
Texture2D<lpfloat> viewDepth : register(t0);
Texture2D<float4> normals : register(t1);
Texture2D<float> deviceDepth : register(t2);
Texture2D<uint> workingAO : register(t3);
Texture2D<lpfloat> edges : register(t4);
SamplerState pointClamp : register(s0);
RWTexture2D<lpfloat> mip0 : register(u0);
RWTexture2D<lpfloat> mip1 : register(u1);
RWTexture2D<lpfloat> mip2 : register(u2);
RWTexture2D<lpfloat> mip3 : register(u3);
RWTexture2D<lpfloat> mip4 : register(u4);
RWTexture2D<uint> outputAO : register(u0);
RWTexture2D<unorm float> outputEdges : register(u1);

[numthreads(8,8,1)]
void Prefilter(uint2 pixel : SV_DispatchThreadID, uint2 local : SV_GroupThreadID) {
    XeGTAO_PrefilterDepths16x16(pixel, local, settings, deviceDepth, pointClamp, mip0, mip1, mip2, mip3, mip4);
}

[numthreads(8,8,1)]
void Main(uint2 pixel : SV_DispatchThreadID) {
    if (deviceDepth.Load(int3(pixel,0)) == 0) {
        outputAO[pixel] = 170;
        outputEdges[pixel] = 0;
        return;
    }
    uint index = HilbertIndex(pixel.x % 64, pixel.y % 64);
    float2 noise = frac(0.5 + index * float2(0.75487766624669276005, 0.5698402909980532659114));
    XeGTAO_MainPass(pixel, 3, 3, noise, normals.Load(int3(pixel,0)).xyz, settings, viewDepth, pointClamp, outputAO, outputEdges);
}

[numthreads(8,8,1)]
void Denoise(uint2 thread : SV_DispatchThreadID) {
    uint2 pixel = thread * uint2(2,1);
    XeGTAO_Denoise(pixel, settings, workingAO, edges, pointClamp, outputAO, true);
    if (deviceDepth.Load(int3(pixel,0)) == 0) outputAO[pixel] = 255;
    if (deviceDepth.Load(int3(pixel+uint2(1,0),0)) == 0) outputAO[pixel+uint2(1,0)] = 255;
}
