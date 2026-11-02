using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

namespace AoReference {
    public static partial class NativeRunner {
        public static void RunDiligent(string shaderDirectory, string tasksFile, string outputDirectory) {
            if (!BitConverter.IsLittleEndian || IntPtr.Size != 8)
                throw new PlatformNotSupportedException("Diligent reference requires a little-endian 64-bit host");
            string[] lines = File.ReadAllLines(tasksFile);
            string[] header = lines[0].Split('\t');
            if (header.Length != 3 || header[0] != "diligent-temporal-v1")
                throw new InvalidDataException("Invalid Diligent sequence header");
            int width = int.Parse(header[1]), height = int.Parse(header[2]);
            if (width < 16 || height < 16 || width > 1920 || height > 1080)
                throw new InvalidDataException("Diligent sequence dimensions are out of bounds");
            Directory.CreateDirectory(outputDirectory);
            using (var dx = new DirectX(shaderDirectory, width, height)) {
                for (int frame = 0; frame < lines.Length - 1; frame++)
                    dx.RenderDiligent(lines[frame + 1], frame, outputDirectory);
            }
            File.WriteAllText(Path.Combine(outputDirectory, "backend.txt"),
                "D3D11 hardware, feature level 11.0, original DiligentFX HLSL plus labelled history-clipping adaptation, full resolution, R32 depth, R8 AO, R16 history\n");
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PixelViewDesc { public uint Format, Dimension, Mip, Count, Unused0, Unused1; }
        [StructLayout(LayoutKind.Sequential)]
        private struct RasterDesc {
            public uint Fill, Cull;
            public int CounterClockwise, DepthBias;
            public float DepthBiasClamp, SlopeBias;
            public int DepthClip, Scissor, Multisample, Antialiased;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Viewport { public float X, Y, Width, Height, MinDepth, MaxDepth; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ResourceBinding {
            public IntPtr Name;
            public uint Type, Slot, Count, Flags, ReturnType, Dimension, Samples;
        }
        [DllImport("d3dcompiler_47.dll", CallingConvention = CallingConvention.StdCall)]
        private static extern int D3DReflect(IntPtr data, UIntPtr size, ref Guid iid, out IntPtr reflection);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ReflectDesc(IntPtr self, IntPtr desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ReflectBinding(IntPtr self, uint index, out ResourceBinding desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreatePixelView(IntPtr self, IntPtr resource, ref PixelViewDesc desc, out IntPtr view);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateRaster(IntPtr self, ref RasterDesc desc, out IntPtr raster);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetRaster(IntPtr self, IntPtr raster);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetViewport(IntPtr self, uint count, ref Viewport viewport);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetTargets(IntPtr self, uint count, IntPtr[] targets, IntPtr depth);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void ClearTarget(IntPtr self, IntPtr target, float[] color);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void DrawInstanced(IntPtr self, uint vertices, uint instances, uint startVertex, uint startInstance);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetIndexBuffer(IntPtr self, IntPtr buffer, uint format, uint offset);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void DrawIndexed(IntPtr self, uint indices, uint startIndex, int baseVertex);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetTopology(IntPtr self, uint topology);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void UpdateResource(IntPtr self, IntPtr target, uint subresource, IntPtr box, IntPtr data, uint pitch, uint slicePitch);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void CopySubresource(IntPtr self, IntPtr target, uint targetMip, uint x, uint y, uint z, IntPtr source, uint sourceMip, IntPtr box);

        private sealed partial class DirectX {
            private sealed class PixelPass {
                public IntPtr Shader;
                public readonly Dictionary<string, ResourceBinding> Bindings = new Dictionary<string, ResourceBinding>();
            }
            private sealed class PixelTexture {
                public Texture Texture;
                public IntPtr[] Rtv, Srv;
            }
            private sealed class HistoryLane {
                public PixelTexture[] Ao, Count, Guide;
                public PixelTexture ConvolutionAo, ConvolutionDepth, Resampled, Final;
            }
            private int pixelWidth, pixelHeight;
            private IntPtr fullScreenVertex, pixelCamera, pixelSettings, pixelIndex, pointClamp, linearClamp;
            private readonly Dictionary<string, PixelPass> pixelPasses = new Dictionary<string, PixelPass>();
            private PixelTexture inputDepth, inputNormal, inputMotion, inputSpatial, prefiltered, noiseXY, noiseZW, nativeRaw, reprojected, closestMotion;
            private PixelTexture previousDepth, diagnostic;
            private Texture zeroSobol, zeroScramble;
            private HistoryLane nativeLane, sharedLane, clippedLane;

            public DirectX(string directory, int width, int height) {
                pixelWidth = width; pixelHeight = height;
                try {
                    uint level;
                    Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, new uint[] { 0xb000 }, 1, 7, out device, out level, out context), "Create native Diligent device");
                    fullScreenVertex = CompilePixel(directory, "FullScreenTriangleVS.fx", "FullScreenTriangleVS", true).Shader;
                    foreach (string[] entry in new string[][] {
                        new string[] {"noise", "ComputeBlueNoiseTexture.fx", "ComputeBlueNoiseTexturePS"},
                        new string[] {"reproject", "ComputeReprojectedDepth.fx", "ComputeReprojectedDepthPS"},
                        new string[] {"motion", "ComputeClosestMotion.fx", "ComputeClosestMotionPS"},
                        new string[] {"prefilter", "SSAO_ComputePrefilteredDepthBuffer.fx", "ComputePrefilteredDepthBufferPS"},
                        new string[] {"ao", "SSAO_ComputeAmbientOcclusion.fx", "ComputeAmbientOcclusionPS"},
                        new string[] {"temporal", "SSAO_ComputeTemporalAccumulation.fx", "ComputeTemporalAccumulationPS"},
                        new string[] {"temporal-clipped", "SSAO_ComputeTemporalAccumulation_Clipped.fx", "ComputeTemporalAccumulationPS"},
                        new string[] {"convolve", "SSAO_ComputeConvolutedDepthHistory.fx", "ComputeConvolutedDepthHistoryPS"},
                        new string[] {"resample", "SSAO_ComputeResampledHistory.fx", "ComputeResampledHistoryPS"},
                        new string[] {"spatial", "SSAO_ComputeSpatialReconstruction.fx", "ComputeSpatialReconstructionPS"},
                        new string[] {"diagnostic", "diligent-diagnostic.fx", "DiagnosticPS"}
                    }) pixelPasses.Add(entry[0], CompilePixel(directory, entry[1], entry[2], false));
                    var rasterDesc = new RasterDesc { Fill = 3, Cull = 1, DepthClip = 1 };
                    IntPtr raster;
                    Check(Method<CreateRaster>(device, 22)(device, ref rasterDesc, out raster), "Create reference raster state");
                    resources.Add(raster); Method<SetRaster>(context, 43)(context, raster);
                    Method<SetTopology>(context, 24)(context, 4);
                    Method<SetShader>(context, 11)(context, fullScreenVertex, IntPtr.Zero, 0);
                    pointClamp = PixelSampler(0); linearClamp = PixelSampler(0x15);
                    pixelCamera = PixelUniform(1152); pixelSettings = PixelUniform(48); pixelIndex = PixelUniform(12, 2);
                    inputDepth = PixelTarget(width, height, 41, 4, 1);
                    previousDepth = PixelTarget(width, height, 41, 4, 1);
                    inputNormal = PixelTarget(width, height, 10, 8, 1);
                    inputMotion = PixelTarget(width, height, 16, 8, 1);
                    inputSpatial = PixelTarget(width, height, 54, 2, 1);
                    prefiltered = PixelTarget(width, height, 41, 4, 5);
                    nativeRaw = PixelTarget(width, height, 61, 1, 1);
                    reprojected = PixelTarget(width, height, 41, 4, 1);
                    closestMotion = PixelTarget(width, height, 34, 4, 1);
                    noiseXY = PixelTarget(128, 128, 49, 2, 1);
                    noiseZW = PixelTarget(128, 128, 49, 2, 1);
                    diagnostic = PixelTarget(width, height, 2, 16, 1);
                    // SSAO consumes only the upstream ZW output; its XY Sobol resources are unused by AO.
                    zeroSobol = NewTexture(256, 1, 62, 1, 1, false, new byte[256]);
                    zeroScramble = NewTexture(512, 256, 62, 1, 1, false, new byte[512 * 256]);
                    nativeLane = NewHistory(); sharedLane = NewHistory(); clippedLane = NewHistory(true);
                } catch { Dispose(); throw; }
            }

            private PixelPass CompilePixel(string directory, string file, string entry, bool vertex) {
                string path = Path.Combine(directory, file);
                string prefix = "#include \"HLSLDefinitions.fxh\"\n#define SUPPORTED_SHADER_SRV 1\n#define SSAO_OPTION_INVERTED_DEPTH 1\n" +
                    "#define POSTFX_OPTION_INVERTED_DEPTH 1\n#define SSAO_OPTION_HALF_RESOLUTION 0\n#define SSAO_OPTION_HALF_PRECISION_DEPTH 0\n#define SSAO_ALGORITHM 0\n";
                byte[] bytes = Encoding.UTF8.GetBytes(prefix + File.ReadAllText(path));
                IntPtr code = IntPtr.Zero, errors = IntPtr.Zero, reflection = IntPtr.Zero;
                try {
                    int hr = D3DCompile(bytes, (UIntPtr)bytes.Length, path, IntPtr.Zero, new IntPtr(1), entry, vertex ? "vs_5_0" : "ps_5_0", 1u << 11, 0, out code, out errors);
                    if (errors != IntPtr.Zero) {
                        string text = Marshal.PtrToStringAnsi(Method<BlobPointer>(errors, 3)(errors), checked((int)Method<BlobSize>(errors, 4)(errors)));
                        if (hr < 0) throw new InvalidOperationException("Original Diligent " + entry + " failed to compile:\n" + text);
                        Console.Error.WriteLine(text);
                    }
                    Check(hr, "Compile original Diligent " + entry);
                    var pass = new PixelPass();
                    Check(Method<CreateShader>(device, vertex ? 12 : 15)(device, Method<BlobPointer>(code, 3)(code), Method<BlobSize>(code, 4)(code), IntPtr.Zero, out pass.Shader), "Create Diligent shader");
                    resources.Add(pass.Shader);
                    if (!vertex) {
                        var iid = new Guid("8d536ca1-0cca-4956-a837-786963755584");
                        Check(D3DReflect(Method<BlobPointer>(code, 3)(code), Method<BlobSize>(code, 4)(code), ref iid, out reflection), "Reflect Diligent bindings");
                        IntPtr desc = Marshal.AllocHGlobal(512);
                        try {
                            Check(Method<ReflectDesc>(reflection, 3)(reflection, desc), "Reflect shader description");
                            int count = Marshal.ReadInt32(desc, 24);
                            for (uint i = 0; i < count; i++) {
                                ResourceBinding binding;
                                Check(Method<ReflectBinding>(reflection, 6)(reflection, i, out binding), "Reflect shader input");
                                pass.Bindings.Add(Marshal.PtrToStringAnsi(binding.Name), binding);
                            }
                        } finally { Marshal.FreeHGlobal(desc); }
                    }
                    return pass;
                } finally { Release(reflection); Release(code); Release(errors); }
            }

            private IntPtr PixelSampler(uint filter) {
                var desc = new SamplerDesc { Filter = filter, U = 3, V = 3, W = 3, Comparison = 1, MaxLod = float.MaxValue };
                IntPtr result;
                Check(Method<CreateSampler>(device, 23)(device, ref desc, out result), "Create Diligent sampler");
                resources.Add(result); return result;
            }
            private IntPtr PixelUniform(int size, uint bind = 4) {
                var desc = new BufferDesc { Bytes = (uint)size, Bind = bind };
                var pin = GCHandle.Alloc(new byte[size], GCHandleType.Pinned);
                try {
                    var subresource = new Subresource { Data = pin.AddrOfPinnedObject() };
                    IntPtr buffer;
                    Check(Method<CreateBuffer>(device, 3)(device, ref desc, ref subresource, out buffer), "Create Diligent constants");
                    resources.Add(buffer); return buffer;
                } finally { pin.Free(); }
            }
            private PixelTexture PixelTarget(int width, int height, uint format, int bytes, uint mips) {
                var target = new PixelTexture { Texture = NewTexture(width, height, format, bytes, mips, false, null, 32), Rtv = new IntPtr[mips], Srv = new IntPtr[mips] };
                for (uint mip = 0; mip < mips; mip++) {
                    var desc = new PixelViewDesc { Format = format, Dimension = 4, Mip = mip, Count = 1 };
                    Check(Method<CreatePixelView>(device, 7)(device, target.Texture.Handle, ref desc, out target.Srv[mip]), "Create one-mip Diligent SRV");
                    Check(Method<CreatePixelView>(device, 9)(device, target.Texture.Handle, ref desc, out target.Rtv[mip]), "Create Diligent RTV");
                    resources.Add(target.Srv[mip]); resources.Add(target.Rtv[mip]);
                }
                return target;
            }
            private HistoryLane NewHistory(bool guide = false) {
                var lane = new HistoryLane {
                    Ao = new PixelTexture[] { PixelTarget(pixelWidth, pixelHeight, 61, 1, 1), PixelTarget(pixelWidth, pixelHeight, 61, 1, 1) },
                    Count = new PixelTexture[] { PixelTarget(pixelWidth, pixelHeight, 54, 2, 1), PixelTarget(pixelWidth, pixelHeight, 54, 2, 1) },
                    ConvolutionAo = PixelTarget(pixelWidth, pixelHeight, 61, 1, 5),
                    ConvolutionDepth = PixelTarget(pixelWidth, pixelHeight, 41, 4, 5),
                    Resampled = PixelTarget(pixelWidth, pixelHeight, 61, 1, 1),
                    Final = PixelTarget(pixelWidth, pixelHeight, 61, 1, 1)
                };
                if(guide) lane.Guide = new PixelTexture[] {PixelTarget(pixelWidth,pixelHeight,54,2,1),PixelTarget(pixelWidth,pixelHeight,54,2,1)};
                for (int i = 0; i < 2; i++) { Clear(lane.Ao[i]); Clear(lane.Count[i]); }
                if(guide)for(int i=0;i<2;i++)Clear(lane.Guide[i]);
                return lane;
            }
            private void Clear(PixelTexture target) {
                Method<ClearTarget>(context, 50)(context, target.Rtv[0], new float[] {1, 0, 0, 0});
            }
            private void UnbindPixel() {
                Method<SetTargets>(context, 33)(context, 0, new IntPtr[0], IntPtr.Zero);
                Method<SetResources>(context, 8)(context, 0, 16, new IntPtr[16]);
            }
            private void Upload(IntPtr target, byte[] bytes, uint pitch = 0) {
                var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try { Method<UpdateResource>(context, 48)(context, target, 0, IntPtr.Zero, pin.AddrOfPinnedObject(), pitch, 0); }
                finally { pin.Free(); }
            }
            private void CopyMip(PixelTexture source, uint sourceMip, PixelTexture target, uint targetMip) {
                UnbindPixel();
                Method<CopySubresource>(context, 46)(context, target.Texture.Handle, targetMip, 0, 0, 0, source.Texture.Handle, sourceMip, IntPtr.Zero);
            }
            private void PixelDraw(string name, Dictionary<string, IntPtr> inputs, PixelTexture[] targets, uint mip = 0, uint instance = 0) {
                UnbindPixel();
                var pass = pixelPasses[name];
                foreach (var pair in pass.Bindings) {
                    ResourceBinding binding = pair.Value;
                    IntPtr resource;
                    if (binding.Type == 0) {
                        if (pair.Key == "cbCameraAttribs") resource = pixelCamera;
                        else if (pair.Key == "cbScreenSpaceAmbientOcclusionAttribs") resource = pixelSettings;
                        else throw new InvalidDataException("Unmapped upstream constant buffer: " + pair.Key);
                        Method<SetResources>(context, 16)(context, binding.Slot, 1, new IntPtr[] {resource});
                    } else if (binding.Type == 3) {
                        resource = pair.Key == "g_TextureDepth_sampler" ? linearClamp : pointClamp;
                        Method<SetResources>(context, 10)(context, binding.Slot, 1, new IntPtr[] {resource});
                    } else if (binding.Type == 2) {
                        if (!inputs.TryGetValue(pair.Key, out resource)) throw new InvalidDataException("Unmapped upstream texture: " + pair.Key + " in " + name);
                        Method<SetResources>(context, 8)(context, binding.Slot, 1, new IntPtr[] {resource});
                    } else throw new InvalidDataException("Unsupported upstream binding type: " + binding.Type);
                }
                var views = new IntPtr[targets.Length];
                for (int i = 0; i < views.Length; i++) views[i] = targets[i].Rtv[mip];
                Method<SetTargets>(context, 33)(context, (uint)views.Length, views, IntPtr.Zero);
                var viewport = new Viewport { Width = Math.Max(1, targets[0].Texture.Desc.Width >> (int)mip), Height = Math.Max(1, targets[0].Texture.Desc.Height >> (int)mip), MaxDepth = 1 };
                Method<SetViewport>(context, 44)(context, 1, ref viewport);
                Method<SetShader>(context, 9)(context, pass.Shader, IntPtr.Zero, 0);
                if (name == "noise") {
                    // Match PostFXContext's D3D11 path: base instance/vertex do not supply SV_VertexID.
                    var indices = new uint[] {instance * 3, instance * 3 + 1, instance * 3 + 2};
                    var indexBytes = new byte[12];
                    Buffer.BlockCopy(indices, 0, indexBytes, 0, 12);
                    Upload(pixelIndex, indexBytes);
                    Method<SetIndexBuffer>(context, 19)(context, pixelIndex, 42, 0);
                    Method<DrawIndexed>(context, 12)(context, 3, 0, 0);
                } else Method<DrawInstanced>(context, 21)(context, 3, 1, 0, 0);
                UnbindPixel();
            }
            private void DenoiseLane(HistoryLane lane, PixelTexture current, int frame, string output, string prefix, string temporalPass = "temporal") {
                int index = frame & 1, old = 1 - index;
                Clear(lane.Ao[index]); Clear(lane.Count[index]);
                if(lane.Guide!=null)Clear(lane.Guide[index]);
                var inputs=new Dictionary<string, IntPtr> {
                    {"g_TextureCurrOcclusion",current.Texture.View}, {"g_TexturePrevOcclusion",lane.Ao[old].Texture.View},
                    {"g_TextureHistory",lane.Count[old].Texture.View}, {"g_TextureCurrDepth",reprojected.Texture.View},
                    {"g_TexturePrevDepth",previousDepth.Texture.View}, {"g_TextureMotion",closestMotion.Texture.View},
                    {"g_ClipDepth",inputDepth.Texture.View},{"g_ClipNormal",inputNormal.Texture.View}
                };
                if(lane.Guide!=null)inputs.Add("g_ClipPreviousGuide",lane.Guide[old].Texture.View);
                PixelDraw(temporalPass,inputs,lane.Guide==null?new PixelTexture[] {lane.Ao[index], lane.Count[index]}:new PixelTexture[]{lane.Ao[index],lane.Count[index],lane.Guide[index]});
                File.WriteAllBytes(Path.Combine(output, prefix + "-temporal.u8"), Read(lane.Ao[index].Texture, 0));
                File.WriteAllBytes(Path.Combine(output, prefix + "-history.r16"), Read(lane.Count[index].Texture, 0));
                CopyMip(lane.Ao[index], 0, lane.ConvolutionAo, 0);
                CopyMip(inputDepth, 0, lane.ConvolutionDepth, 0);
                for (uint mip = 1; mip < 5; mip++)
                    PixelDraw("convolve", new Dictionary<string, IntPtr> {
                        {"g_TextureHistoryLastMip",lane.ConvolutionAo.Srv[mip-1]}, {"g_TextureDepthLastMip",lane.ConvolutionDepth.Srv[mip-1]}
                    }, new PixelTexture[] {lane.ConvolutionAo, lane.ConvolutionDepth}, mip);
                if (frame == 0 && prefix == "shared")
                    for (uint mip = 0; mip < 5; mip++) {
                        File.WriteAllBytes(Path.Combine(output, prefix + "-mip" + mip + "-ao.u8"), Read(lane.ConvolutionAo.Texture, mip));
                        File.WriteAllBytes(Path.Combine(output, prefix + "-mip" + mip + "-depth.f32"), Read(lane.ConvolutionDepth.Texture, mip));
                    }
                PixelDraw("resample", new Dictionary<string, IntPtr> {
                    {"g_TextureOcclusion",lane.ConvolutionAo.Texture.View}, {"g_TextureDepth",lane.ConvolutionDepth.Texture.View},
                    {"g_TextureHistory",lane.Count[index].Texture.View}, {"g_TextureNormal",inputNormal.Texture.View}
                }, new PixelTexture[] {lane.Resampled});
                PixelDraw("spatial", new Dictionary<string, IntPtr> {
                    {"g_TextureOcclusion",lane.Resampled.Texture.View}, {"g_TextureDepth",inputDepth.Texture.View},
                    {"g_TextureHistory",lane.Count[index].Texture.View}, {"g_TextureNormal",inputNormal.Texture.View}
                }, new PixelTexture[] {lane.Final});
                File.WriteAllBytes(Path.Combine(output, prefix + "-resampled.u8"), Read(lane.Resampled.Texture, 0));
                File.WriteAllBytes(Path.Combine(output, prefix + "-final.u8"), Read(lane.Final.Texture, 0));
                CopyMip(lane.Final, 0, lane.Ao[index], 0);
            }
            private static byte[] ExactBytes(BinaryReader reader, int count) {
                byte[] bytes = reader.ReadBytes(count);
                if (bytes.Length != count) throw new InvalidDataException("Truncated captured AO frame");
                return bytes;
            }
            public void RenderDiligent(string input, int frame, string outputDirectory) {
                int pixels = checked(pixelWidth * pixelHeight);
                byte[] camera, depth, normal, motion, spatial;
                using (var file = File.OpenRead(input))
                using (var gzip = new GZipStream(file, CompressionMode.Decompress))
                using (var reader = new BinaryReader(gzip)) {
                    if (reader.ReadUInt32() != 0x31464f41 || reader.ReadInt32() != frame || reader.ReadInt32() != pixelWidth || reader.ReadInt32() != pixelHeight)
                        throw new InvalidDataException("Captured frame header mismatch");
                    camera = ExactBytes(reader, 1152);
                    depth = ExactBytes(reader, pixels * 4); normal = ExactBytes(reader, pixels * 8);
                    motion = ExactBytes(reader, pixels * 8); spatial = ExactBytes(reader, pixels * 2);
                    ExactBytes(reader, pixels * 2); // BLite accumulated AO.
                    ExactBytes(reader, pixels * 2); // BLite final AO is compared by the host.
                    if (frame == 0) ExactBytes(reader, pixels * 16); // Independent geometry diagnostic.
                    if (reader.ReadByte() != 0x7f || gzip.ReadByte() != -1) throw new InvalidDataException("Captured frame trailer mismatch");
                }
                Upload(pixelCamera, camera);
                var settings = new byte[48];
                float[] values = {0.6f,0.615f,1.457f,3.3f,0.9f,4f,0f,1f,0.5f,0f,0f,0f};
                Buffer.BlockCopy(values, 0, settings, 0, 48);
                if (frame == 0) Buffer.BlockCopy(BitConverter.GetBytes(1), 0, settings, 24, 4);
                Upload(pixelSettings, settings);
                Upload(inputDepth.Texture.Handle, depth, (uint)pixelWidth * 4);
                // WORLD_NORMAL stores N*0.5+0.5; Diligent's input is signed world space.
                for (int pixel = 0; pixel < normal.Length; pixel += 8) {
                    for (int channel = 0; channel < 3; channel++) {
                        int offset = pixel + channel * 2;
                        float encoded = (float)BitConverter.UInt16BitsToHalf(BitConverter.ToUInt16(normal, offset));
                        if (!float.IsFinite(encoded) || encoded < -0.00000011920928955078125f || encoded > 1.00000011920928955078125f)
                            throw new InvalidDataException("Invalid encoded world-normal input");
                        ushort signed = BitConverter.HalfToUInt16Bits((Half)(encoded * 2f - 1f));
                        normal[offset] = (byte)signed; normal[offset + 1] = (byte)(signed >> 8);
                    }
                }
                Upload(inputNormal.Texture.Handle, normal, (uint)pixelWidth * 8);
                if (frame == 0) File.WriteAllBytes(Path.Combine(outputDirectory, "normal-input.rgba16"), normal);
                File.AppendAllText(Path.Combine(outputDirectory, "normal-input-sha256.tsv"),
                    frame.ToString("D4") + "\t" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(normal)).ToLowerInvariant() + "\n");
                Upload(inputMotion.Texture.Handle, motion, (uint)pixelWidth * 8);
                Upload(inputSpatial.Texture.Handle, spatial, (uint)pixelWidth * 2);
                string output = Path.Combine(outputDirectory, frame.ToString("D4"));
                Directory.CreateDirectory(output);
                PixelDraw("noise", new Dictionary<string, IntPtr> {{"g_SobolBuffer",zeroSobol.View},{"g_ScramblingTileBuffer",zeroScramble.View}},
                    new PixelTexture[] {noiseXY,noiseZW}, 0, (uint)frame);
                PixelDraw("reproject", new Dictionary<string, IntPtr> {{"g_TextureDepth",inputDepth.Texture.View}}, new PixelTexture[] {reprojected});
                PixelDraw("motion", new Dictionary<string, IntPtr> {{"g_TextureDepth",inputDepth.Texture.View},{"g_TextureMotion",inputMotion.Texture.View}}, new PixelTexture[] {closestMotion});
                CopyMip(inputDepth, 0, prefiltered, 0);
                for (uint mip = 1; mip < 5; mip++)
                    PixelDraw("prefilter", new Dictionary<string, IntPtr> {{"g_TextureLastMip",prefiltered.Srv[mip-1]}}, new PixelTexture[] {prefiltered}, mip);
                Clear(nativeRaw);
                PixelDraw("ao", new Dictionary<string, IntPtr> {
                    {"g_TexturePrefilteredDepth",prefiltered.Texture.View}, {"g_TextureNormal",inputNormal.Texture.View}, {"g_TextureBlueNoise",noiseZW.Texture.View}
                }, new PixelTexture[] {nativeRaw});
                File.WriteAllBytes(Path.Combine(output, "native-raw.u8"), Read(nativeRaw.Texture, 0));
                if (frame == 0) {
                    PixelDraw("diagnostic", new Dictionary<string, IntPtr> {{"g_TextureDepth",inputDepth.Texture.View}}, new PixelTexture[] {diagnostic});
                    File.WriteAllBytes(Path.Combine(output, "reconstructed-position.rgba32"), Read(diagnostic.Texture, 0));
                }
                DenoiseLane(nativeLane, nativeRaw, frame, output, "native");
                DenoiseLane(sharedLane, inputSpatial, frame, output, "shared");
                DenoiseLane(clippedLane, inputSpatial, frame, output, "clipped", "temporal-clipped");
                CopyMip(inputDepth, 0, previousDepth, 0);
                if (frame % 16 == 0) Console.WriteLine("Native Diligent frame " + frame);
            }
        }
    }
}
