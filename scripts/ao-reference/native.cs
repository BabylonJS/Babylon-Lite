using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AoReference {
    public static class NativeRunner {
        public static void Run(string shaderDirectory, string tasksFile) {
            using (var dx = new DirectX(File.ReadAllText(Path.Combine(shaderDirectory, "reference.hlsl"))))
            using (var gl = new OpenGL(File.ReadAllText(Path.Combine(shaderDirectory, "reference.frag")))) {
                foreach (string line in File.ReadAllLines(tasksFile)) {
                    string[] cells = line.Split('\t');
                    if (cells.Length != 12) throw new InvalidDataException("AO native task must have exactly 12 columns");
                    var task = new Fixture(cells);
                    Directory.CreateDirectory(task.Output);
                    float[][] mips = dx.Render(task);
                    gl.Render(task, mips);
                    File.WriteAllText(Path.Combine(task.Output, "backend.txt"), "D3D11 hardware, feature level 11.0, cs_5_0, FP32\n" + gl.Description + "\n");
                }
            }
            foreach (var variant in new string[][] {
                new string[] { "reference-slope-safe.frag", "vbao-slope-safe.f32" },
                new string[] { "reference-slope-safe-probe.frag", "vbao-slope-safe-samples.f32" }
            }) {
                using (var gl = new OpenGL(File.ReadAllText(Path.Combine(shaderDirectory, variant[0])))) {
                    foreach (string line in File.ReadAllLines(tasksFile)) {
                        var task = new Fixture(line.Split('\t'));
                        var mips = new float[5][];
                        for (int mip = 0; mip < mips.Length; mip++)
                            mips[mip] = ReadFloats(Path.Combine(task.Output, "depth-mip" + mip + ".f32"), (task.Width >> mip) * (task.Height >> mip));
                        gl.Render(task, mips, variant[1]);
                    }
                }
            }
        }

        internal sealed class Fixture {
            public readonly string Input, Output;
            public readonly int Width, Height, Slices, Steps;
            public readonly float Near, Far, TanY, Radius, Thickness;
            public readonly float[] Depth, Normals;
            public Fixture(string[] cells) {
                Input = cells[0]; Output = cells[1];
                Width = int.Parse(cells[2], CultureInfo.InvariantCulture);
                Height = int.Parse(cells[3], CultureInfo.InvariantCulture);
                Near = Parse(cells[4]); Far = Parse(cells[5]); TanY = Parse(cells[6]);
                Radius = Parse(cells[7]); Thickness = Parse(cells[8]);
                Slices = int.Parse(cells[9], CultureInfo.InvariantCulture);
                Steps = int.Parse(cells[10], CultureInfo.InvariantCulture);
                if (cells[11] != "ao-reference-v1" || Width < 16 || Height < 16 || Width % 16 != 0 || Height % 16 != 0 ||
                    Slices != 3 || Steps != 3 || Near <= 0 || Far <= Near || TanY <= 0 || Radius <= 0 || Thickness <= 0)
                    throw new InvalidDataException("Unsupported AO fixture settings");
                Depth = ReadFloats(Path.Combine(Input, "depth.f32"), Width * Height);
                Normals = ReadFloats(Path.Combine(Input, "normals.f32"), Width * Height * 4);
            }
            private static float Parse(string value) {
                float result = float.Parse(value, CultureInfo.InvariantCulture);
                if (!float.IsFinite(result)) throw new InvalidDataException("Non-finite AO setting");
                return result;
            }
        }

        private static float[] ReadFloats(string path, int count) {
            byte[] bytes = File.ReadAllBytes(path);
            if (!BitConverter.IsLittleEndian || bytes.Length != count * 4) throw new InvalidDataException("Incorrect AO float buffer size/byte order: " + path);
            float[] values = new float[count];
            Buffer.BlockCopy(bytes, 0, values, 0, bytes.Length);
            foreach (float value in values) if (!float.IsFinite(value)) throw new InvalidDataException("Non-finite input: " + path);
            return values;
        }
        private static byte[] FloatBytes(float[] values) {
            byte[] bytes = new byte[values.Length * 4];
            Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
            return bytes;
        }
        private static void Check(int result, string operation) {
            if (result < 0) throw new InvalidOperationException(operation + " failed: 0x" + result.ToString("X8"));
        }
        private static T Method<T>(IntPtr owner, int slot) where T : Delegate {
            return Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(owner), slot * IntPtr.Size));
        }
        private static void Release(IntPtr value) { if (value != IntPtr.Zero) Marshal.Release(value); }

        [StructLayout(LayoutKind.Sequential)]
        private struct TextureDesc { public uint Width, Height, Mips, ArraySize, Format, SampleCount, SampleQuality, Usage, Bind, CpuAccess, Misc; }
        [StructLayout(LayoutKind.Sequential)]
        private struct BufferDesc { public uint Bytes, Usage, Bind, CpuAccess, Misc, Stride; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Subresource { public IntPtr Data; public uint Pitch, SlicePitch; }
        [StructLayout(LayoutKind.Sequential)]
        private struct UavDesc { public uint Format, Dimension, Mip, Unused0, Unused1; }
        [StructLayout(LayoutKind.Sequential)]
        private struct SamplerDesc {
            public uint Filter, U, V, W;
            public float Bias;
            public uint Anisotropy, Comparison;
            public float Border0, Border1, Border2, Border3, MinLod, MaxLod;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Mapped { public IntPtr Data; public uint Pitch, DepthPitch; }
        [DllImport("d3d11.dll", CallingConvention = CallingConvention.StdCall)]
        private static extern int D3D11CreateDevice(IntPtr adapter, uint driver, IntPtr software, uint flags, uint[] levels, uint levelCount, uint sdk,
            out IntPtr device, out uint selectedLevel, out IntPtr context);
        [DllImport("d3dcompiler_47.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
        private static extern int D3DCompile(byte[] source, UIntPtr length, string name, IntPtr defines, IntPtr include, string entry, string target,
            uint flags, uint effectFlags, out IntPtr code, out IntPtr errors);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr data, out IntPtr texture);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateBuffer(IntPtr self, ref BufferDesc desc, ref Subresource data, out IntPtr buffer);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateView(IntPtr self, IntPtr resource, IntPtr desc, out IntPtr view);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateUav(IntPtr self, IntPtr resource, ref UavDesc desc, out IntPtr view);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateShader(IntPtr self, IntPtr code, UIntPtr length, IntPtr linkage, out IntPtr shader);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateSampler(IntPtr self, ref SamplerDesc desc, out IntPtr sampler);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate IntPtr BlobPointer(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate UIntPtr BlobSize(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetResources(IntPtr self, uint start, uint count, IntPtr[] resources);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetUavs(IntPtr self, uint start, uint count, IntPtr[] resources, IntPtr initialCounts);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void SetShader(IntPtr self, IntPtr shader, IntPtr instances, uint count);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void Dispatch(IntPtr self, uint x, uint y, uint z);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void CopyResource(IntPtr self, IntPtr destination, IntPtr source);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Map(IntPtr self, IntPtr resource, uint index, uint type, uint flags, out Mapped mapped);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void Unmap(IntPtr self, IntPtr resource, uint index);

        private sealed class DirectX : IDisposable {
            private IntPtr device, context;
            private readonly List<IntPtr> resources = new List<IntPtr>();
            private IntPtr prefilter, main, denoise, sampler;
            private sealed class Texture {
                public IntPtr Handle, View;
                public IntPtr[] Uavs;
                public TextureDesc Desc;
                public int PixelBytes;
            }
            public DirectX(string source) {
                try {
                    uint level;
                    Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, new uint[] { 0xb000 }, 1, 7, out device, out level, out context), "D3D11CreateDevice");
                    prefilter = Compile(source, "Prefilter"); main = Compile(source, "Main"); denoise = Compile(source, "Denoise");
                    var desc = new SamplerDesc { U = 3, V = 3, W = 3, Comparison = 1, MaxLod = float.MaxValue };
                    Check(Method<CreateSampler>(device, 23)(device, ref desc, out sampler), "CreateSamplerState");
                    resources.Add(sampler);
                } catch { Dispose(); throw; }
            }
            private IntPtr Compile(string source, string entry) {
                byte[] bytes = Encoding.UTF8.GetBytes(source);
                IntPtr code = IntPtr.Zero, errors = IntPtr.Zero;
                try {
                    int result = D3DCompile(bytes, (UIntPtr)bytes.Length, "reference.hlsl", IntPtr.Zero, IntPtr.Zero, entry, "cs_5_0", 1u << 11, 0, out code, out errors);
                    if (errors != IntPtr.Zero) {
                        string diagnostic = Marshal.PtrToStringAnsi(Method<BlobPointer>(errors, 3)(errors), checked((int)Method<BlobSize>(errors, 4)(errors)));
                        if (result < 0) throw new InvalidOperationException("Upstream HLSL " + entry + " compilation failed:\n" + diagnostic);
                        Console.Error.WriteLine(diagnostic);
                    }
                    Check(result, "D3DCompile " + entry);
                    IntPtr shader;
                    Check(Method<CreateShader>(device, 18)(device, Method<BlobPointer>(code, 3)(code), Method<BlobSize>(code, 4)(code), IntPtr.Zero, out shader), "CreateComputeShader");
                    resources.Add(shader);
                    return shader;
                } finally { Release(code); Release(errors); }
            }
            private Texture NewTexture(int width, int height, uint format, int pixelBytes, uint mips, bool writable, byte[] input = null) {
                var desc = new TextureDesc { Width = (uint)width, Height = (uint)height, Mips = mips, ArraySize = 1, Format = format, SampleCount = 1, Bind = 8u | (writable ? 128u : 0u) };
                var texture = new Texture { Desc = desc, PixelBytes = pixelBytes, Uavs = new IntPtr[writable ? mips : 0] };
                GCHandle pin = default(GCHandle);
                IntPtr data = IntPtr.Zero;
                try {
                    if (input != null) {
                        pin = GCHandle.Alloc(input, GCHandleType.Pinned);
                        data = Marshal.AllocHGlobal(Marshal.SizeOf<Subresource>());
                        Marshal.StructureToPtr(new Subresource { Data = pin.AddrOfPinnedObject(), Pitch = (uint)(width * pixelBytes) }, data, false);
                    }
                    Check(Method<CreateTexture>(device, 5)(device, ref desc, data, out texture.Handle), "CreateTexture2D");
                    resources.Add(texture.Handle);
                    Check(Method<CreateView>(device, 7)(device, texture.Handle, IntPtr.Zero, out texture.View), "CreateShaderResourceView");
                    resources.Add(texture.View);
                    for (uint i = 0; i < texture.Uavs.Length; i++) {
                        var viewDesc = new UavDesc { Format = format, Dimension = 4, Mip = i };
                        Check(Method<CreateUav>(device, 8)(device, texture.Handle, ref viewDesc, out texture.Uavs[i]), "CreateUnorderedAccessView");
                        resources.Add(texture.Uavs[i]);
                    }
                    return texture;
                } finally {
                    if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
                    if (pin.IsAllocated) pin.Free();
                }
            }
            private IntPtr Constants(Fixture task) {
                byte[] bytes;
                float tx = task.TanY * task.Width / task.Height;
                using (var stream = new MemoryStream())
                using (var writer = new BinaryWriter(stream)) {
                    writer.Write(task.Width); writer.Write(task.Height);
                    writer.Write(1f / task.Width); writer.Write(1f / task.Height);
                    writer.Write(-task.Near * task.Far / (task.Far - task.Near)); writer.Write(-task.Near / (task.Far - task.Near));
                    writer.Write(tx); writer.Write(task.TanY);
                    writer.Write(2 * tx); writer.Write(-2 * task.TanY); writer.Write(-tx); writer.Write(task.TanY);
                    writer.Write(2 * tx / task.Width); writer.Write(-2 * task.TanY / task.Height);
                    writer.Write(task.Radius); writer.Write(0.615f); writer.Write(1.457f); writer.Write(0f);
                    writer.Write(2.2f); writer.Write(1.2f); writer.Write(2f); writer.Write(0f); writer.Write(3.3f); writer.Write(0);
                    bytes = stream.ToArray();
                }
                var desc = new BufferDesc { Bytes = (uint)bytes.Length, Bind = 4 };
                GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try {
                    var data = new Subresource { Data = pin.AddrOfPinnedObject() };
                    IntPtr buffer;
                    Check(Method<CreateBuffer>(device, 3)(device, ref desc, ref data, out buffer), "CreateBuffer");
                    resources.Add(buffer);
                    return buffer;
                } finally { pin.Free(); }
            }
            private void RunPass(IntPtr shader, IntPtr[] inputs, IntPtr[] outputs, uint x, uint y) {
                Method<SetResources>(context, 67)(context, 0, (uint)inputs.Length, inputs);
                Method<SetUavs>(context, 68)(context, 0, (uint)outputs.Length, outputs, IntPtr.Zero);
                Method<SetShader>(context, 69)(context, shader, IntPtr.Zero, 0);
                Method<Dispatch>(context, 41)(context, x, y, 1);
                Method<SetResources>(context, 67)(context, 0, 5, new IntPtr[5]);
                Method<SetUavs>(context, 68)(context, 0, 5, new IntPtr[5], IntPtr.Zero);
            }
            private byte[] Read(Texture texture, uint mip) {
                var desc = texture.Desc; desc.Usage = 3; desc.Bind = 0; desc.CpuAccess = 0x20000;
                IntPtr staging;
                Check(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out staging), "Create staging texture");
                try {
                    Method<CopyResource>(context, 47)(context, staging, texture.Handle);
                    Mapped mapped;
                    Check(Method<Map>(context, 14)(context, staging, mip, 1, 0, out mapped), "Map reference output");
                    try {
                        int width = Math.Max(1, (int)desc.Width >> (int)mip), height = Math.Max(1, (int)desc.Height >> (int)mip);
                        byte[] bytes = new byte[width * height * texture.PixelBytes];
                        for (int y = 0; y < height; y++) Marshal.Copy(IntPtr.Add(mapped.Data, checked(y * (int)mapped.Pitch)), bytes, y * width * texture.PixelBytes, width * texture.PixelBytes);
                        return bytes;
                    } finally { Method<Unmap>(context, 15)(context, staging, mip); }
                } finally { Release(staging); }
            }
            public float[][] Render(Fixture task) {
                int first = resources.Count;
                try {
                    var depth = NewTexture(task.Width, task.Height, 41, 4, 1, false, FloatBytes(task.Depth));
                    var normal = NewTexture(task.Width, task.Height, 2, 16, 1, false, FloatBytes(task.Normals));
                    var pyramid = NewTexture(task.Width, task.Height, 41, 4, 5, true);
                    var raw = NewTexture(task.Width, task.Height, 62, 1, 1, true);
                    var edge = NewTexture(task.Width, task.Height, 61, 1, 1, true);
                    var final = NewTexture(task.Width, task.Height, 62, 1, 1, true);
                    Method<SetResources>(context, 70)(context, 0, 1, new IntPtr[] { sampler });
                    Method<SetResources>(context, 71)(context, 0, 1, new IntPtr[] { Constants(task) });
                    RunPass(prefilter, new IntPtr[] { IntPtr.Zero, IntPtr.Zero, depth.View }, pyramid.Uavs, (uint)task.Width / 16, (uint)task.Height / 16);
                    RunPass(main, new IntPtr[] { pyramid.View, normal.View, depth.View }, new IntPtr[] { raw.Uavs[0], edge.Uavs[0] }, (uint)task.Width / 8, (uint)task.Height / 8);
                    RunPass(denoise, new IntPtr[] { IntPtr.Zero, IntPtr.Zero, depth.View, raw.View, edge.View }, final.Uavs, (uint)task.Width / 16, (uint)task.Height / 8);
                    var mips = new float[5][];
                    for (uint i = 0; i < 5; i++) {
                        byte[] bytes = Read(pyramid, i);
                        File.WriteAllBytes(Path.Combine(task.Output, "depth-mip" + i + ".f32"), bytes);
                        mips[i] = new float[bytes.Length / 4]; Buffer.BlockCopy(bytes, 0, mips[i], 0, bytes.Length);
                    }
                    byte[] rawBytes = Read(raw, 0);
                    byte[] rawWords = new byte[rawBytes.Length * 4];
                    for (int i = 0; i < rawBytes.Length; i++) rawWords[i * 4] = rawBytes[i];
                    File.WriteAllBytes(Path.Combine(task.Output, "xegtao-raw.u32"), rawWords);
                    File.WriteAllBytes(Path.Combine(task.Output, "xegtao-edges.u8"), Read(edge, 0));
                    byte[] packed = Read(final, 0);
                    float[] visibility = new float[packed.Length];
                    for (int i = 0; i < visibility.Length; i++) visibility[i] = packed[i] / 255f;
                    File.WriteAllBytes(Path.Combine(task.Output, "xegtao.f32"), FloatBytes(visibility));
                    return mips;
                } finally {
                    Method<SetResources>(context, 71)(context, 0, 1, new IntPtr[1]);
                    for (int i = resources.Count - 1; i >= first; i--) { Release(resources[i]); resources.RemoveAt(i); }
                }
            }
            public void Dispose() {
                for (int i = resources.Count - 1; i >= 0; i--) Release(resources[i]);
                resources.Clear(); Release(context); Release(device); context = device = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WindowClass {
            public uint Style; public IntPtr Procedure; public int ClassBytes, WindowBytes;
            public IntPtr Instance, Icon, Cursor, Background; public string Menu, Name;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct PixelFormat {
            public ushort Size, Version; public uint Flags;
            public byte Type, ColorBits, RedBits, RedShift, GreenBits, GreenShift, BlueBits, BlueShift, AlphaBits, AlphaShift;
            public byte AccumBits, AccumRed, AccumGreen, AccumBlue, AccumAlpha, DepthBits, StencilBits, Auxiliary, Layer, Reserved;
            public uint LayerMask, VisibleMask, DamageMask;
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassW(ref WindowClass value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowExW(uint extended, string name, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClassW(string name, IntPtr instance);
        [DllImport("gdi32.dll")] private static extern int ChoosePixelFormat(IntPtr dc, ref PixelFormat format);
        [DllImport("gdi32.dll")] private static extern bool SetPixelFormat(IntPtr dc, int index, ref PixelFormat format);
        [DllImport("opengl32.dll")] private static extern IntPtr wglCreateContext(IntPtr dc);
        [DllImport("opengl32.dll")] private static extern bool wglMakeCurrent(IntPtr dc, IntPtr context);
        [DllImport("opengl32.dll")] private static extern bool wglDeleteContext(IntPtr context);
        [DllImport("opengl32.dll", CharSet = CharSet.Ansi)] private static extern IntPtr wglGetProcAddress(string name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr w, IntPtr l);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr CreateGlContext(IntPtr dc, IntPtr share, int[] attributes);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlGen(int count, out uint name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlDelete(int count, uint[] names);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlBind(uint target, uint name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlOne(uint value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint GlCreate(uint type);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint GlCreateProgram();
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlShaderSource(uint shader, int count, IntPtr[] text, int[] lengths);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlGetStatus(uint name, uint parameter, out int value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Ansi)] private delegate void GlGetLog(uint name, int length, out int count, StringBuilder log);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlAttach(uint program, uint shader);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlImage(uint target, int level, int internalFormat, int width, int height, int border, uint format, uint type, IntPtr data);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlParameter(uint target, uint parameter, int value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlAttachment(uint target, uint attachment, uint textureTarget, uint texture, int level);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint GlStatus(uint target);
        [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Ansi)] private delegate int GlLocation(uint program, string name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlInt(int location, int value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlFloat(int location, float value);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlVec2(int location, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlVec4(int location, float x, float y, float z, float w);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlViewport(int x, int y, int width, int height);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlDraw(uint mode, int first, int count);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void GlRead(int x, int y, int width, int height, uint format, uint type, IntPtr output);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr GlString(uint name);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint GlError();

        private sealed class OpenGL : IDisposable {
            private IntPtr window, dc, context, library;
            private ushort atom;
            private readonly WindowProcedure procedure = DefWindowProcW;
            private readonly Dictionary<string, Delegate> functions = new Dictionary<string, Delegate>();
            private uint program, vao;
            public string Description { get; private set; }
            private T Function<T>(string name) where T : Delegate {
                Delegate cached;
                if (functions.TryGetValue(name, out cached)) return (T)cached;
                IntPtr pointer = wglGetProcAddress(name);
                if (pointer == IntPtr.Zero || pointer.ToInt64() == 1 || pointer.ToInt64() == 2 || pointer.ToInt64() == 3 || pointer.ToInt64() == -1)
                    pointer = NativeLibrary.GetExport(library, name);
                var result = Marshal.GetDelegateForFunctionPointer<T>(pointer);
                functions.Add(name, result);
                return result;
            }
            public OpenGL(string fragment) {
                try {
                    library = NativeLibrary.Load("opengl32.dll");
                    var wc = new WindowClass { Name = "BLiteAoReference", Procedure = Marshal.GetFunctionPointerForDelegate(procedure), Style = 0x20 };
                    atom = RegisterClassW(ref wc);
                    if (atom == 0) throw new InvalidOperationException("Cannot register reference-only OpenGL window: " + Marshal.GetLastWin32Error());
                    window = CreateWindowExW(0, wc.Name, "", 0x80000000, 0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                    if (window == IntPtr.Zero) throw new InvalidOperationException("Cannot create hidden OpenGL reference window");
                    dc = GetDC(window);
                    var format = new PixelFormat { Size = (ushort)Marshal.SizeOf<PixelFormat>(), Version = 1, Flags = 0x24, ColorBits = 32 };
                    int pixelFormat = ChoosePixelFormat(dc, ref format);
                    if (pixelFormat == 0 || !SetPixelFormat(dc, pixelFormat, ref format)) throw new InvalidOperationException("Cannot set reference OpenGL pixel format");
                    context = wglCreateContext(dc);
                    if (context == IntPtr.Zero || !wglMakeCurrent(dc, context)) throw new InvalidOperationException("Cannot initialize reference OpenGL");
                    IntPtr core = Function<CreateGlContext>("wglCreateContextAttribsARB")(dc, IntPtr.Zero, new int[] { 0x2091, 4, 0x2092, 3, 0x9126, 1, 0 });
                    if (core == IntPtr.Zero) throw new InvalidOperationException("AO reference requires an OpenGL 4.3 driver");
                    wglMakeCurrent(IntPtr.Zero, IntPtr.Zero); wglDeleteContext(context); context = core;
                    if (!wglMakeCurrent(dc, context)) throw new InvalidOperationException("Cannot activate owned reference context");
                    functions.Clear();
                    Description = "OpenGL " + Marshal.PtrToStringAnsi(Function<GlString>("glGetString")(0x1f02)) + "\n" + Marshal.PtrToStringAnsi(Function<GlString>("glGetString")(0x1f01));
                    string vertex = "#version 430 core\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";
                    uint vs = Compile(vertex, 0x8b31), fs = 0;
                    try {
                        fs = Compile(fragment, 0x8b30); program = Function<GlCreateProgram>("glCreateProgram")();
                        Function<GlAttach>("glAttachShader")(program, vs); Function<GlAttach>("glAttachShader")(program, fs);
                        Function<GlOne>("glLinkProgram")(program);
                        CheckShader(program, true);
                    } finally { Function<GlOne>("glDeleteShader")(vs); if (fs != 0) Function<GlOne>("glDeleteShader")(fs); }
                    Function<GlGen>("glGenVertexArrays")(1, out vao);
                } catch { Dispose(); throw; }
            }
            private uint Compile(string source, uint type) {
                uint shader = Function<GlCreate>("glCreateShader")(type);
                IntPtr text = Marshal.StringToCoTaskMemUTF8(source);
                try {
                    Function<GlShaderSource>("glShaderSource")(shader, 1, new IntPtr[] { text }, new int[] { Encoding.UTF8.GetByteCount(source) });
                    Function<GlOne>("glCompileShader")(shader);
                    CheckShader(shader, false);
                    return shader;
                } catch { Function<GlOne>("glDeleteShader")(shader); throw; }
                finally { Marshal.FreeCoTaskMem(text); }
            }
            private void CheckShader(uint shader, bool linked) {
                int status;
                Function<GlGetStatus>(linked ? "glGetProgramiv" : "glGetShaderiv")(shader, linked ? 0x8b82u : 0x8b81u, out status);
                if (status == 0) {
                    var log = new StringBuilder(32768); int count;
                    Function<GlGetLog>(linked ? "glGetProgramInfoLog" : "glGetShaderInfoLog")(shader, log.Capacity, out count, log);
                    throw new InvalidOperationException("Upstream GLSL " + (linked ? "link" : "compile") + " failed:\n" + log);
                }
            }
            private int Location(string name) {
                int result = Function<GlLocation>("glGetUniformLocation")(program, name);
                if (result < 0) throw new InvalidOperationException("Missing required VBAO uniform: " + name);
                return result;
            }
            private void Scalar(string name, float value) { Function<GlFloat>("glUniform1f")(Location(name), value); }
            private static float[] FlipRows(float[] values, int width, int height, int components) {
                var flipped = new float[values.Length];
                for (int y = 0; y < height; y++) Array.Copy(values, y * width * components, flipped, (height - 1 - y) * width * components, width * components);
                return flipped;
            }
            private uint Texture(int width, int height, float[][] levels, bool rgba) {
                uint texture; Function<GlGen>("glGenTextures")(1, out texture);
                Function<GlBind>("glBindTexture")(0x0de1, texture);
                Function<GlParameter>("glTexParameteri")(0x0de1, 0x2801, 0x2700);
                Function<GlParameter>("glTexParameteri")(0x0de1, 0x2800, 0x2600);
                Function<GlParameter>("glTexParameteri")(0x0de1, 0x2802, 0x812f);
                Function<GlParameter>("glTexParameteri")(0x0de1, 0x2803, 0x812f);
                Function<GlParameter>("glTexParameteri")(0x0de1, 0x813d, levels.Length - 1);
                for (int i = 0; i < levels.Length; i++) {
                    GCHandle pin = default(GCHandle);
                    try {
                        if (levels[i] != null) pin = GCHandle.Alloc(levels[i], GCHandleType.Pinned);
                        Function<GlImage>("glTexImage2D")(0x0de1, i, rgba ? 0x8814 : 0x822e, Math.Max(1, width >> i), Math.Max(1, height >> i), 0,
                            rgba ? 0x1908u : 0x1903u, 0x1406, pin.IsAllocated ? pin.AddrOfPinnedObject() : IntPtr.Zero);
                    } finally { if (pin.IsAllocated) pin.Free(); }
                }
                return texture;
            }
            public void Render(Fixture task, float[][] positiveMips, string outputName = "vbao.f32") {
                var textures = new List<uint>();
                uint framebuffer = 0;
                try {
                    Function<GlOne>("glUseProgram")(program);
                    var negativeMips = new float[positiveMips.Length][];
                    for (int i = 0; i < positiveMips.Length; i++) {
                        negativeMips[i] = new float[positiveMips[i].Length];
                        for (int p = 0; p < negativeMips[i].Length; p++) negativeMips[i][p] = -positiveMips[i][p];
                        negativeMips[i] = FlipRows(negativeMips[i], Math.Max(1, task.Width >> i), Math.Max(1, task.Height >> i), 1);
                    }
                    Function<GlOne>("glActiveTexture")(0x84c0);
                    textures.Add(Texture(task.Width, task.Height, negativeMips, false));
                    Function<GlInt>("glUniform1i")(Location("materialParams_depth"), 0);
                    Function<GlOne>("glActiveTexture")(0x84c1);
                    textures.Add(Texture(task.Width, task.Height, new float[][] { FlipRows(task.Normals, task.Width, task.Height, 4) }, true));
                    Function<GlInt>("glUniform1i")(Location("normalInput"), 1);
                    Function<GlOne>("glActiveTexture")(0x84c2);
                    textures.Add(Texture(task.Width, task.Height, new float[][] { FlipRows(task.Depth, task.Width, task.Height, 1) }, false));
                    Function<GlInt>("glUniform1i")(Location("deviceDepthInput"), 2);
                    Function<GlOne>("glActiveTexture")(0x84c3);
                    uint output = Texture(task.Width, task.Height, new float[][] { null }, false); textures.Add(output);
                    Function<GlGen>("glGenFramebuffers")(1, out framebuffer);
                    Function<GlBind>("glBindFramebuffer")(0x8d40, framebuffer);
                    Function<GlAttachment>("glFramebufferTexture2D")(0x8d40, 0x8ce0, 0x0de1, output, 0);
                    uint state = Function<GlStatus>("glCheckFramebufferStatus")(0x8d40);
                    if (state != 0x8cd5) throw new InvalidOperationException("Reference framebuffer incomplete: 0x" + state.ToString("X"));
                    Function<GlVec4>("glUniform4f")(Location("materialParams.resolution"), task.Width, task.Height, 1f / task.Width, 1f / task.Height);
                    Function<GlVec2>("glUniform2f")(Location("materialParams.positionParams"), 2 * task.TanY * task.Width / task.Height, 2 * task.TanY);
                    Function<GlVec2>("glUniform2f")(Location("materialParams.sliceCount"), task.Slices, 1f / task.Slices);
                    Function<GlInt>("glUniform1i")(Location("materialParams.maxLevel"), 4);
                    Scalar("materialParams.projectionScaleRadius", task.Radius * task.Height / (2 * task.TanY));
                    Scalar("materialParams.stepsPerSlice", task.Steps);
                    Scalar("materialParams.constThickness", task.Thickness);
                    Function<GlViewport>("glViewport")(0, 0, task.Width, task.Height);
                    Function<GlOne>("glBindVertexArray")(vao);
                    Function<GlDraw>("glDrawArrays")(4, 0, 3);
                    float[] result = new float[task.Width * task.Height];
                    GCHandle pin = GCHandle.Alloc(result, GCHandleType.Pinned);
                    try { Function<GlRead>("glReadPixels")(0, 0, task.Width, task.Height, 0x1903, 0x1406, pin.AddrOfPinnedObject()); }
                    finally { pin.Free(); }
                    uint error = Function<GlError>("glGetError")();
                    if (error != 0) throw new InvalidOperationException("Reference OpenGL execution failed: 0x" + error.ToString("X"));
                    File.WriteAllBytes(Path.Combine(task.Output, outputName), FloatBytes(FlipRows(result, task.Width, task.Height, 1)));
                } finally {
                    Function<GlBind>("glBindFramebuffer")(0x8d40, 0);
                    if (framebuffer != 0) Function<GlDelete>("glDeleteFramebuffers")(1, new uint[] { framebuffer });
                    if (textures.Count > 0) Function<GlDelete>("glDeleteTextures")(textures.Count, textures.ToArray());
                }
            }
            public void Dispose() {
                if (context != IntPtr.Zero) {
                    if (program != 0) Function<GlOne>("glDeleteProgram")(program);
                    if (vao != 0) Function<GlDelete>("glDeleteVertexArrays")(1, new uint[] { vao });
                    wglMakeCurrent(IntPtr.Zero, IntPtr.Zero); wglDeleteContext(context); context = IntPtr.Zero;
                }
                if (dc != IntPtr.Zero) { ReleaseDC(window, dc); dc = IntPtr.Zero; }
                if (window != IntPtr.Zero) { DestroyWindow(window); window = IntPtr.Zero; }
                if (atom != 0) { UnregisterClassW("BLiteAoReference", IntPtr.Zero); atom = 0; }
                if (library != IntPtr.Zero) { NativeLibrary.Free(library); library = IntPtr.Zero; }
                GC.KeepAlive(procedure);
            }
        }
    }
}
