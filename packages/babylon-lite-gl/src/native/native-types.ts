/**
 * Type surface for the Babylon Native `_native` bridge, scoped to exactly what
 * `@babylonjs/lite-gl`'s native backend uses. This is a focused port of the
 * relevant declarations in Babylon.js's
 * `packages/dev/core/src/Engines/Native/nativeInterfaces.ts` — kept local so the
 * native backend has ZERO dependency on `@babylonjs/core`, mirroring the WebGL
 * backend's dependency-free stance.
 *
 * `_native` is a global injected by the Babylon Native host (bgfx-backed).
 * Rendering is a COMMAND-STREAM model: the JS side records commands into a
 * `NativeDataStream` (see native-command-encoder.ts) which the host consumes and
 * submits per frame — there is no immediate-mode WebGL context.
 */

/** An opaque native resource handle (program / buffer / texture / framebuffer /
 *  vertex-array / uniform / command tag). Encoded as a little block of uint32s. */
export type NativeData = Uint32Array;

/** Native handle aliases, mirroring Babylon's `nativeInterfaces.ts`. */
export type NativeTexture = NativeData;
/** Opaque native framebuffer handle. */
export type NativeFramebuffer = NativeData;
/** Opaque native vertex-array handle. */
export type NativeVertexArrayObject = NativeData;
/** Opaque native program handle. */
export type NativeProgram = NativeData;
/** Opaque native uniform-location handle. */
export type NativeUniform = NativeData;

/** The raw stream the host reads command bytes from. */
export interface INativeDataStream {
    /** Hand a filled command buffer to the host. */
    writeBuffer(buffer: ArrayBuffer, length: number): void;
}

/** Constructor for {@link INativeDataStream}. */
export interface INativeDataStreamConstructor {
    /** Prototype (host-provided). */
    prototype: INativeDataStream;
    /** Create a stream; `requestFlushCallback` is invoked when the host wants a flush. */
    new (requestFlushCallback: () => void): INativeDataStream;
}

/** The JS wrapper handed to {@link INativeEngine.setCommandDataStream}. The host
 *  reads the raw {@link INativeDataStream} off its `_nativeDataStream` property
 *  (see NativeEngine.cpp), so the wrapper — not the raw stream — is passed. */
export interface INativeCommandStreamWrapper {
    /** @internal ABI property NAME read by the host (`_nativeDataStream`); must not
     *  be renamed or property-mangled. `@internal` strips it from the `.d.ts` only —
     *  the runtime property is preserved. */
    readonly _nativeDataStream: INativeDataStream;
}

/** Engine construction info (protocol handshake with the native side). */
export interface INativeEngineInfo {
    /** Protocol version string. */
    version: string;
    /** Always `true` for lite-gl — it never uploads non-float vertex buffers. */
    nonFloatVertexBuffers: true;
}

/** GPU-frame timing stats populated by the host. */
export interface NativeFrameStats {
    /** GPU time for the last frame, in nanoseconds. */
    gpuTimeNs: number;
}

/**
 * The native engine instance — the command sink + resource factory. Only the
 * members `@babylonjs/lite-gl` calls are declared. Signatures match Babylon's
 * `INativeEngine`.
 */
export interface INativeEngine {
    /** Tear down the engine + its GPU device. */
    dispose(): void;
    /** Schedule `callback` for the next native frame (drives the render loop). */
    requestAnimationFrame(callback: () => void): void;
    /** Fires on the device-restored edge (bgfx re-init). Preferred name. */
    setRenderResetCallback?(callback: () => void): void;
    /** @deprecated Older BabylonNative name for {@link setRenderResetCallback}. */
    setDeviceLostCallback?(callback: () => void): void;

    /** Allocate a native vertex-array object. */
    createVertexArray(): NativeData;

    /** Create + upload an index buffer from a slice of `dataBuffer`. */
    createIndexBuffer(dataBuffer: ArrayBufferLike, dataByteOffset: number, dataByteLength: number, is32Bits: boolean, dynamic: boolean): NativeData;
    /** Attach an index buffer to a vertex array. */
    recordIndexBuffer(vertexArray: NativeData, indexBuffer: NativeData): void;
    /** Re-upload part of a dynamic index buffer. */
    updateDynamicIndexBuffer(indexBuffer: NativeData, data: ArrayBufferLike, dataByteOffset: number, dataByteLength: number, startIndex: number): void;

    /** Create + upload a vertex buffer from a slice of `dataBuffer`. */
    createVertexBuffer(dataBuffer: ArrayBufferLike, dataByteOffset: number, dataByteLength: number, dynamic: boolean): NativeData;
    /** Record one attribute of a vertex buffer into a vertex array. */
    recordVertexBuffer(
        vertexArray: NativeData,
        vertexBuffer: NativeData,
        location: number,
        byteOffset: number,
        byteStride: number,
        numElements: number,
        type: number,
        normalized: boolean,
        instanceDivisor: number
    ): void;
    /** Re-upload part of a dynamic vertex buffer. */
    updateDynamicVertexBuffer(vertexBuffer: NativeData, dataBuffer: ArrayBufferLike, dataByteOffset: number, dataByteLength: number, vertexByteOffset?: number): void;

    /** Synchronously compile + link a program. Throws on error. */
    createProgram(vertexShader: string, fragmentShader: string): NativeProgram;
    /** Asynchronously compile + link a program; `onSuccess`/`onError` report completion. */
    createProgramAsync(vertexShader: string, fragmentShader: string, onSuccess: () => void, onError: (error: Error) => void): NativeProgram;
    /** Resolve uniform-location handles by name. */
    getUniforms(shaderProgram: NativeProgram, uniformsNames: string[]): NativeUniform[];
    /** Resolve attribute locations by name (`-1` when absent). */
    getAttributes(shaderProgram: NativeProgram, attributeNames: string[]): number[];

    /** Allocate an (uninitialized) native texture handle. */
    createTexture(): NativeTexture;
    /** Allocate texture storage (also used for render-target color attachments). */
    initializeTexture(
        texture: NativeTexture,
        width: number,
        height: number,
        hasMips: boolean,
        format: number,
        renderTarget: boolean,
        srgb: boolean,
        samples: number,
        isCube?: boolean
    ): void;
    /** Decode + upload an encoded image (png/jpg/…) into a texture. */
    loadTexture(texture: NativeTexture, data: ArrayBufferView, generateMips: boolean, invertY: boolean, srgb: boolean, onSuccess: () => void, onError: () => void): void;
    /** Upload raw pixel data into a texture. */
    loadRawTexture(texture: NativeTexture, data: ArrayBufferView, width: number, height: number, format: number, generateMips: boolean, invertY: boolean): void;
    /** Update a sub-rectangle of a texture's pixels. */
    updateTextureData?(
        texture: NativeTexture,
        data: ArrayBufferView,
        xOffset: number,
        yOffset: number,
        width: number,
        height: number,
        faceIndex: number,
        lod: number,
        invertY: boolean
    ): void;
    /** Width of a texture in texels. */
    getTextureWidth(texture: NativeTexture): number;
    /** Height of a texture in texels. */
    getTextureHeight(texture: NativeTexture): number;
    /** Release a texture. */
    deleteTexture(texture: NativeTexture): void;
    /** Read back a texture region (async — the native readback is not immediate). */
    readTexture(
        texture: NativeTexture,
        mipLevel: number,
        x: number,
        y: number,
        width: number,
        height: number,
        buffer: ArrayBuffer | null,
        bufferOffset: number,
        bufferLength: number
    ): Promise<ArrayBuffer>;

    /** Create a framebuffer wrapping `texture` (+ optional depth/stencil). */
    createFrameBuffer(
        texture: NativeTexture | null,
        width: number,
        height: number,
        generateStencilBuffer: boolean,
        generateDepthBuffer: boolean,
        samples: number,
        layer?: number
    ): NativeFramebuffer;

    /** Current backbuffer width in physical pixels. */
    getRenderWidth(): number;
    /** Current backbuffer height in physical pixels. */
    getRenderHeight(): number;
    /** Set the hardware-scaling level (drawingBufferSize = cssSize / level). */
    setHardwareScalingLevel(level: number): void;
    /** Set the backbuffer viewport (immediate — not command-streamed). */
    setViewPort(x: number, y: number, width: number, height: number): void;

    /** Install the command stream the encoder writes into. The host reads the raw
     *  native stream off the wrapper's `_nativeDataStream` property (see
     *  NativeEngine.cpp), so an {@link INativeCommandStreamWrapper} is passed here. */
    setCommandDataStream(dataStream: INativeCommandStreamWrapper): void;
    /** Submit all recorded commands to the host for this batch. */
    submitCommands(): void;

    /** Populate GPU-timing stats (optional on older hosts). */
    populateFrameStats?(stats: NativeFrameStats): void;

    /** Decode an encoded image (png/jpg/…) synchronously. Absent (or throwing)
     *  when the host is built without image loading. */
    createImageBitmap?(data: ArrayBuffer): NativeImageBitmap;
}

/** Decoded image returned by `_native.Engine#createImageBitmap(arrayBuffer)`
 *  (requires a host built with `LOAD_IMAGES`). The pixel layout is the decoded
 *  image's own bgfx format (`format`, a `_native.Engine.TEXTURE_FORMAT_*` value —
 *  typically RGBA8 for png, RGB8 for jpg). lite-gl accepts any object of this
 *  shape as a texture source; `format` defaults to RGBA8 when omitted. */
export interface NativeImageBitmap {
    /** Decoded pixel bytes, tightly packed rows. */
    data: Uint8Array;
    /** Width in texels. */
    width: number;
    /** Height in texels. */
    height: number;
    /** Pixel format (`_native.Engine.TEXTURE_FORMAT_*`). Default RGBA8. */
    format?: number;
}

/**
 * Static side of the native `Engine` — the protocol version, capability limits,
 * enum tables and (crucially) every `COMMAND_*` tag the command encoder writes.
 * Only the members lite-gl uses are declared.
 */
export interface INativeEngineConstructor {
    /** Prototype (host-provided). */
    prototype: INativeEngine;
    /** Construct the engine after the protocol handshake. */
    new (info: INativeEngineInfo): INativeEngine;

    /** Wire-protocol version — must match the native `NativeEngine.cpp`. */
    readonly PROTOCOL_VERSION: number;
    /** Largest supported texture dimension, in texels. */
    readonly CAPS_LIMITS_MAX_TEXTURE_SIZE: number;
    /** Largest supported texture-array layer count. */
    readonly CAPS_LIMITS_MAX_TEXTURE_LAYERS: number;

    // Texture sampling modes (min/mag + mip), used by SETTEXTURESAMPLING.
    /** Nearest min + nearest mag, no mips. */
    readonly TEXTURE_NEAREST_NEAREST: number;
    /** Linear min + linear mag, no mips. */
    readonly TEXTURE_LINEAR_LINEAR: number;
    /** Linear min + linear mag + trilinear mips. */
    readonly TEXTURE_LINEAR_LINEAR_MIPLINEAR: number;
    /** Nearest min + nearest mag + nearest mips. */
    readonly TEXTURE_NEAREST_NEAREST_MIPNEAREST: number;
    /** Nearest min + linear mag, no mips. */
    readonly TEXTURE_NEAREST_LINEAR: number;
    readonly TEXTURE_NEAREST_LINEAR_MIPNEAREST: number;
    readonly TEXTURE_NEAREST_LINEAR_MIPLINEAR: number;
    readonly TEXTURE_NEAREST_NEAREST_MIPLINEAR: number;
    readonly TEXTURE_LINEAR_NEAREST_MIPNEAREST: number;
    readonly TEXTURE_LINEAR_NEAREST_MIPLINEAR: number;
    readonly TEXTURE_LINEAR_LINEAR_MIPNEAREST: number;
    readonly TEXTURE_LINEAR_NEAREST: number;

    // Texture addressing (wrap) modes, used by SETTEXTUREWRAPMODE.
    /** Repeat. */
    readonly ADDRESS_MODE_WRAP: number;
    /** Mirrored repeat. */
    readonly ADDRESS_MODE_MIRROR: number;
    /** Clamp to edge. */
    readonly ADDRESS_MODE_CLAMP: number;

    /** Float attribute element type (lite-gl only uses float attributes). */
    readonly ATTRIB_TYPE_FLOAT: number;

    // Blend presets, used by SETBLENDMODE (values match Babylon Constants.ALPHA_*).
    /** No blending. */
    readonly ALPHA_DISABLE: number;
    /** Additive. */
    readonly ALPHA_ADD: number;
    /** Standard (non-premultiplied) alpha. */
    readonly ALPHA_COMBINE: number;
    /** Premultiplied alpha. */
    readonly ALPHA_PREMULTIPLIED: number;

    // Texture formats used by initializeTexture / render targets.
    /** 8-bit RGBA. */
    readonly TEXTURE_FORMAT_RGBA8: number;
    /** 32-bit float RGBA. */
    readonly TEXTURE_FORMAT_RGBA32F: number;
    /** 16-bit half-float RGBA. */
    readonly TEXTURE_FORMAT_RGBA16F: number;
    /** 8-bit single-channel. */
    readonly TEXTURE_FORMAT_R8: number;
    /** 8-bit two-channel. */
    readonly TEXTURE_FORMAT_RG8: number;
    readonly TEXTURE_FORMAT_RGB8: number;
    readonly TEXTURE_FORMAT_R16F: number;
    readonly TEXTURE_FORMAT_R32F: number;
    readonly TEXTURE_FORMAT_RG16F: number;
    readonly TEXTURE_FORMAT_RG32F: number;

    // Depth comparison, used by SETDEPTHTEST.
    /** Pass when incoming depth is less than the stored value. */
    readonly DEPTH_TEST_LESS: number;
    readonly DEPTH_TEST_LEQUAL: number;
    readonly DEPTH_TEST_EQUAL: number;
    readonly DEPTH_TEST_GEQUAL: number;
    readonly DEPTH_TEST_GREATER: number;
    readonly DEPTH_TEST_NOTEQUAL: number;
    readonly DEPTH_TEST_NEVER: number;
    /** Always pass. */
    readonly DEPTH_TEST_ALWAYS: number;

    // Stencil comparison + ops, used by SETSTENCIL.
    /** Native stencil enum STENCIL_TEST_LESS. */ readonly STENCIL_TEST_LESS: number;
    /** Native stencil enum STENCIL_TEST_LEQUAL. */ readonly STENCIL_TEST_LEQUAL: number;
    /** Native stencil enum STENCIL_TEST_EQUAL. */ readonly STENCIL_TEST_EQUAL: number;
    /** Native stencil enum STENCIL_TEST_GEQUAL. */ readonly STENCIL_TEST_GEQUAL: number;
    /** Native stencil enum STENCIL_TEST_GREATER. */ readonly STENCIL_TEST_GREATER: number;
    /** Native stencil enum STENCIL_TEST_NOTEQUAL. */ readonly STENCIL_TEST_NOTEQUAL: number;
    /** Native stencil enum STENCIL_TEST_NEVER. */ readonly STENCIL_TEST_NEVER: number;
    /** Native stencil enum STENCIL_TEST_ALWAYS. */ readonly STENCIL_TEST_ALWAYS: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_KEEP. */ readonly STENCIL_OP_FAIL_S_KEEP: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_ZERO. */ readonly STENCIL_OP_FAIL_S_ZERO: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_REPLACE. */ readonly STENCIL_OP_FAIL_S_REPLACE: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_INCR. */ readonly STENCIL_OP_FAIL_S_INCR: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_DECR. */ readonly STENCIL_OP_FAIL_S_DECR: number;
    /** Native stencil enum STENCIL_OP_FAIL_S_INVERT. */ readonly STENCIL_OP_FAIL_S_INVERT: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_KEEP. */ readonly STENCIL_OP_FAIL_Z_KEEP: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_ZERO. */ readonly STENCIL_OP_FAIL_Z_ZERO: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_REPLACE. */ readonly STENCIL_OP_FAIL_Z_REPLACE: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_INCR. */ readonly STENCIL_OP_FAIL_Z_INCR: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_DECR. */ readonly STENCIL_OP_FAIL_Z_DECR: number;
    /** Native stencil enum STENCIL_OP_FAIL_Z_INVERT. */ readonly STENCIL_OP_FAIL_Z_INVERT: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_KEEP. */ readonly STENCIL_OP_PASS_Z_KEEP: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_ZERO. */ readonly STENCIL_OP_PASS_Z_ZERO: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_REPLACE. */ readonly STENCIL_OP_PASS_Z_REPLACE: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_INCR. */ readonly STENCIL_OP_PASS_Z_INCR: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_DECR. */ readonly STENCIL_OP_PASS_Z_DECR: number;
    /** Native stencil enum STENCIL_OP_PASS_Z_INVERT. */ readonly STENCIL_OP_PASS_Z_INVERT: number;

    // ─── command tags (opaque NativeData) ───────────────────────────────
    /** Native command tag COMMAND_DELETEVERTEXARRAY. */ readonly COMMAND_DELETEVERTEXARRAY: NativeData;
    /** Native command tag COMMAND_DELETEINDEXBUFFER. */ readonly COMMAND_DELETEINDEXBUFFER: NativeData;
    /** Native command tag COMMAND_DELETEVERTEXBUFFER. */ readonly COMMAND_DELETEVERTEXBUFFER: NativeData;
    /** Native command tag COMMAND_SETPROGRAM. */ readonly COMMAND_SETPROGRAM: NativeData;
    /** Native command tag COMMAND_DELETEPROGRAM. */ readonly COMMAND_DELETEPROGRAM: NativeData;
    /** Native command tag COMMAND_SETMATRIX. */ readonly COMMAND_SETMATRIX: NativeData;
    /** Native command tag COMMAND_SETMATRIX3X3. */ readonly COMMAND_SETMATRIX3X3: NativeData;
    /** Native command tag COMMAND_SETMATRICES. */ readonly COMMAND_SETMATRICES: NativeData;
    /** Native command tag COMMAND_SETINT. */ readonly COMMAND_SETINT: NativeData;
    /** Native command tag COMMAND_SETINTARRAY. */ readonly COMMAND_SETINTARRAY: NativeData;
    /** Native command tag COMMAND_SETFLOAT. */ readonly COMMAND_SETFLOAT: NativeData;
    /** Native command tag COMMAND_SETFLOAT2. */ readonly COMMAND_SETFLOAT2: NativeData;
    /** Native command tag COMMAND_SETFLOAT3. */ readonly COMMAND_SETFLOAT3: NativeData;
    /** Native command tag COMMAND_SETFLOAT4. */ readonly COMMAND_SETFLOAT4: NativeData;
    /** Native command tag COMMAND_SETFLOATARRAY. */ readonly COMMAND_SETFLOATARRAY: NativeData;
    /** Native command tag COMMAND_SETFLOATARRAY4. */ readonly COMMAND_SETFLOATARRAY4: NativeData;
    /** Native command tag COMMAND_SETTEXTURE. */ readonly COMMAND_SETTEXTURE: NativeData;
    /** Native command tag COMMAND_UNSETTEXTURE. */ readonly COMMAND_UNSETTEXTURE: NativeData;
    /** Native command tag COMMAND_COPYTEXTURE. */ readonly COMMAND_COPYTEXTURE: NativeData;
    /** Native command tag COMMAND_SETTEXTURESAMPLING. */ readonly COMMAND_SETTEXTURESAMPLING: NativeData;
    /** Native command tag COMMAND_SETTEXTUREWRAPMODE. */ readonly COMMAND_SETTEXTUREWRAPMODE: NativeData;
    /** Native command tag COMMAND_BINDVERTEXARRAY. */ readonly COMMAND_BINDVERTEXARRAY: NativeData;
    /** Native command tag COMMAND_SETSTATE. */ readonly COMMAND_SETSTATE: NativeData;
    /** Native command tag COMMAND_SETDEPTHTEST. */ readonly COMMAND_SETDEPTHTEST: NativeData;
    /** Native command tag COMMAND_SETDEPTHWRITE. */ readonly COMMAND_SETDEPTHWRITE: NativeData;
    /** Native command tag COMMAND_SETCOLORWRITE. */ readonly COMMAND_SETCOLORWRITE: NativeData;
    /** Native command tag COMMAND_SETBLENDMODE. */ readonly COMMAND_SETBLENDMODE: NativeData;
    /** Native command tag COMMAND_SETSTENCIL. */ readonly COMMAND_SETSTENCIL: NativeData;
    /** Native command tag COMMAND_SETVIEWPORT. */ readonly COMMAND_SETVIEWPORT: NativeData;
    /** Native command tag COMMAND_SETSCISSOR. */ readonly COMMAND_SETSCISSOR: NativeData;
    /** Native command tag COMMAND_BINDFRAMEBUFFER. */ readonly COMMAND_BINDFRAMEBUFFER: NativeData;
    /** Native command tag COMMAND_UNBINDFRAMEBUFFER. */ readonly COMMAND_UNBINDFRAMEBUFFER: NativeData;
    /** Native command tag COMMAND_DELETEFRAMEBUFFER. */ readonly COMMAND_DELETEFRAMEBUFFER: NativeData;
    /** Native command tag COMMAND_DRAWINDEXED. */ readonly COMMAND_DRAWINDEXED: NativeData;
    /** Native command tag COMMAND_DRAWINDEXEDINSTANCED. */ readonly COMMAND_DRAWINDEXEDINSTANCED: NativeData;
    /** Native command tag COMMAND_CLEAR. */ readonly COMMAND_CLEAR: NativeData;
}

/** The global bridge object. Only the members lite-gl uses are declared. */
export interface INative {
    /** Native engine constructor + command/enum tables. */
    Engine: INativeEngineConstructor;
    /** Native command-stream constructor. */
    NativeDataStream: INativeDataStreamConstructor;
}

declare global {
    /** The Babylon Native host injects `_native` as a JS global. */

    var _native: INative;
}
