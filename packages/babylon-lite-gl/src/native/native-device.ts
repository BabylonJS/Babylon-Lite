/**
 * Native device op-layer — the native-backend analogue of the WebGL modules'
 * inline `gl.*` calls, centralized here (native bundle size is not gated, so a
 * shared op layer is preferred to per-module duplication). Every op encodes into
 * the engine's {@link CommandBufferEncoder} or calls the native engine directly.
 *
 * Compare-and-elide caching stays in the higher-level native modules (against
 * `engine._state`), exactly like the WebGL backend — these ops are pure device
 * executors. All ops read `engine._engine` (the native engine) and
 * `engine._encoder` (the command stream); none touch a WebGL context.
 */
import type { GLEngineContext } from "./native-context.js";
import type { NativeData, NativeProgram, NativeTexture, NativeUniform, NativeFramebuffer } from "./native-types.js";

/** Native fill mode for triangles (`Constants.MATERIAL_TriangleFillMode`). */
const NATIVE_FILL_TRIANGLES = 0;

/* ─────────────────────────────  programs  ─────────────────────────────────── */

/** Compile + link a program asynchronously; `onReady`/`onError` fire on
 *  completion. Returns the (immediately usable as a handle) native program. */
export function dCreateProgram(engine: GLEngineContext, vertexSource: string, fragmentSource: string, onReady: () => void, onError: (error: Error) => void): NativeProgram {
    return engine._engine.createProgramAsync(vertexSource, fragmentSource, onReady, onError);
}

/** Resolve uniform-location handles by name (parallel arrays with `names`). */
export function dGetUniformLocations(engine: GLEngineContext, program: NativeProgram, names: string[]): NativeUniform[] {
    return engine._engine.getUniforms(program, names);
}

/** Resolve attribute locations by name (`-1` when absent). */
export function dGetAttributeLocations(engine: GLEngineContext, program: NativeProgram, names: string[]): number[] {
    return engine._engine.getAttributes(program, names);
}

/** `COMMAND_SETPROGRAM`. */
export function dSetProgram(engine: GLEngineContext, program: NativeProgram): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETPROGRAM);
    e.encodeCommandArgAsNativeData(program);
    e.finishEncodingCommand();
}

/** `COMMAND_DELETEPROGRAM`. */
export function dDeleteProgram(engine: GLEngineContext, program: NativeProgram): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_DELETEPROGRAM);
    e.encodeCommandArgAsNativeData(program);
    e.finishEncodingCommand();
}

/* ─────────────────────────────  buffers / VAO  ────────────────────────────── */

/** Create + upload a vertex buffer from a typed-array view. */
export function dCreateVertexBuffer(engine: GLEngineContext, data: ArrayBufferView, dynamic: boolean): NativeData {
    return engine._engine.createVertexBuffer(data.buffer, data.byteOffset, data.byteLength, dynamic);
}

/** Create + upload an index buffer from a typed-array view. */
export function dCreateIndexBuffer(engine: GLEngineContext, data: ArrayBufferView, is32Bits: boolean, dynamic: boolean): NativeData {
    return engine._engine.createIndexBuffer(data.buffer, data.byteOffset, data.byteLength, is32Bits, dynamic);
}

/** Re-upload part of a dynamic vertex buffer. `srcByteLength` (default: the whole
 *  view) lets callers upload only a filled prefix of a larger scratch buffer
 *  WITHOUT allocating a subarray view each frame. */
export function dUpdateVertexBuffer(engine: GLEngineContext, buffer: NativeData, data: ArrayBufferView, dstByteOffset: number, srcByteLength: number = data.byteLength): void {
    engine._engine.updateDynamicVertexBuffer(buffer, data.buffer, data.byteOffset, srcByteLength, dstByteOffset);
}

/** Allocate a native vertex array. */
export function dCreateVertexArray(engine: GLEngineContext): NativeData {
    return engine._engine.createVertexArray();
}

/** Record one FLOAT attribute of a vertex buffer into a vertex array. */
export function dRecordVertexBuffer(
    engine: GLEngineContext,
    vao: NativeData,
    vertexBuffer: NativeData,
    location: number,
    byteOffset: number,
    byteStride: number,
    numElements: number,
    instanceDivisor: number
): void {
    engine._engine.recordVertexBuffer(vao, vertexBuffer, location, byteOffset, byteStride, numElements, _native.Engine.ATTRIB_TYPE_FLOAT, false, instanceDivisor);
}

/** Attach an index buffer to a vertex array. */
export function dRecordIndexBuffer(engine: GLEngineContext, vao: NativeData, indexBuffer: NativeData): void {
    engine._engine.recordIndexBuffer(vao, indexBuffer);
}

/** `COMMAND_BINDVERTEXARRAY`. */
export function dBindVertexArray(engine: GLEngineContext, vao: NativeData): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_BINDVERTEXARRAY);
    e.encodeCommandArgAsNativeData(vao);
    e.finishEncodingCommand();
}

/** `COMMAND_DELETEVERTEXARRAY`. */
export function dDeleteVertexArray(engine: GLEngineContext, vao: NativeData): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_DELETEVERTEXARRAY);
    e.encodeCommandArgAsNativeData(vao);
    e.finishEncodingCommand();
}

/** `COMMAND_DELETEVERTEXBUFFER`. */
export function dDeleteVertexBuffer(engine: GLEngineContext, buffer: NativeData): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_DELETEVERTEXBUFFER);
    e.encodeCommandArgAsNativeData(buffer);
    e.finishEncodingCommand();
}

/** `COMMAND_DELETEINDEXBUFFER`. */
export function dDeleteIndexBuffer(engine: GLEngineContext, buffer: NativeData): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_DELETEINDEXBUFFER);
    e.encodeCommandArgAsNativeData(buffer);
    e.finishEncodingCommand();
}

/* ─────────────────────────────  draw  ─────────────────────────────────────── */

/** `COMMAND_DRAWINDEXED` / `COMMAND_DRAWINDEXEDINSTANCED` for triangles. */
export function dDrawIndexed(engine: GLEngineContext, indexStart: number, indexCount: number, instanceCount: number): void {
    const e = engine._encoder;
    if (instanceCount > 0) {
        e.startEncodingCommand(_native.Engine.COMMAND_DRAWINDEXEDINSTANCED);
        e.encodeCommandArgAsUInt32(NATIVE_FILL_TRIANGLES);
        e.encodeCommandArgAsUInt32(indexStart);
        e.encodeCommandArgAsUInt32(indexCount);
        e.encodeCommandArgAsUInt32(instanceCount);
    } else {
        e.startEncodingCommand(_native.Engine.COMMAND_DRAWINDEXED);
        e.encodeCommandArgAsUInt32(NATIVE_FILL_TRIANGLES);
        e.encodeCommandArgAsUInt32(indexStart);
        e.encodeCommandArgAsUInt32(indexCount);
    }
    e.finishEncodingCommand();
}

/* ─────────────────────────────  uniforms  ─────────────────────────────────── */

/** `COMMAND_SETINT`. */
export function dSetInt(engine: GLEngineContext, uniform: NativeUniform, value: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETINT);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsInt32(value);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOAT`. */
export function dSetFloat(engine: GLEngineContext, uniform: NativeUniform, x: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOAT);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32(x);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOAT2`. */
export function dSetFloat2(engine: GLEngineContext, uniform: NativeUniform, x: number, y: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOAT2);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32(x);
    e.encodeCommandArgAsFloat32(y);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOAT3`. */
export function dSetFloat3(engine: GLEngineContext, uniform: NativeUniform, x: number, y: number, z: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOAT3);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32(x);
    e.encodeCommandArgAsFloat32(y);
    e.encodeCommandArgAsFloat32(z);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOAT4`. */
export function dSetFloat4(engine: GLEngineContext, uniform: NativeUniform, x: number, y: number, z: number, w: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOAT4);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32(x);
    e.encodeCommandArgAsFloat32(y);
    e.encodeCommandArgAsFloat32(z);
    e.encodeCommandArgAsFloat32(w);
    e.finishEncodingCommand();
}

/** `COMMAND_SETMATRICES` — a column-major 4×4 (16 floats), matching Babylon's
 *  `Effect.setMatrix` → `setMatrices`. */
export function dSetMatrix(engine: GLEngineContext, uniform: NativeUniform, matrix: Float32Array | number[]): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETMATRICES);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32s(matrix);
    e.finishEncodingCommand();
}

/** `COMMAND_SETMATRIX3X3`. */
export function dSetMatrix3x3(engine: GLEngineContext, uniform: NativeUniform, matrix: Float32Array | number[]): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETMATRIX3X3);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32s(matrix);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOATARRAY`. */
export function dSetFloatArray(engine: GLEngineContext, uniform: NativeUniform, array: Float32Array | number[]): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOATARRAY);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32s(array);
    e.finishEncodingCommand();
}

/** `COMMAND_SETFLOATARRAY4`. */
export function dSetFloatArray4(engine: GLEngineContext, uniform: NativeUniform, array: Float32Array | number[]): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETFLOATARRAY4);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsFloat32s(array);
    e.finishEncodingCommand();
}

/** `COMMAND_SETINTARRAY`. */
export function dSetIntArray(engine: GLEngineContext, uniform: NativeUniform, array: Int32Array): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETINTARRAY);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsInt32s(array);
    e.finishEncodingCommand();
}

/* ─────────────────────────────  textures  ─────────────────────────────────── */

/** Allocate an (uninitialized) native texture handle. */
export function dCreateTexture(engine: GLEngineContext): NativeTexture {
    return engine._engine.createTexture();
}

/** Allocate texture storage (also used for render-target color attachments). */
export function dInitializeTexture(engine: GLEngineContext, texture: NativeTexture, width: number, height: number, hasMips: boolean, format: number, renderTarget: boolean): void {
    engine._engine.initializeTexture(texture, width, height, hasMips, format, renderTarget, false, 1);
}

/** Upload raw pixel data into a texture. */
export function dLoadRawTexture(
    engine: GLEngineContext,
    texture: NativeTexture,
    data: ArrayBufferView,
    width: number,
    height: number,
    format: number,
    generateMips: boolean,
    invertY: boolean
): void {
    engine._engine.loadRawTexture(texture, data, width, height, format, generateMips, invertY);
}

/** Decode + upload an encoded image (png/jpg/…). */
export function dLoadTexture(
    engine: GLEngineContext,
    texture: NativeTexture,
    data: ArrayBufferView,
    generateMips: boolean,
    invertY: boolean,
    onSuccess: () => void,
    onError: () => void
): void {
    engine._engine.loadTexture(texture, data, generateMips, invertY, false, onSuccess, onError);
}

/** Update a sub-rectangle of a texture's pixels (dynamic textures). */
export function dUpdateTextureData(
    engine: GLEngineContext,
    texture: NativeTexture,
    data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
    invertY: boolean
): void {
    engine._engine.updateTextureData?.(texture, data, x, y, width, height, 0, 0, invertY);
}

/** `COMMAND_SETTEXTURESAMPLING`. */
export function dSetTextureSampling(engine: GLEngineContext, texture: NativeTexture, filter: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETTEXTURESAMPLING);
    e.encodeCommandArgAsNativeData(texture);
    e.encodeCommandArgAsUInt32(filter);
    e.finishEncodingCommand();
}

/** `COMMAND_SETTEXTUREWRAPMODE`. */
export function dSetTextureWrap(engine: GLEngineContext, texture: NativeTexture, addressU: number, addressV: number, addressW: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETTEXTUREWRAPMODE);
    e.encodeCommandArgAsNativeData(texture);
    e.encodeCommandArgAsUInt32(addressU);
    e.encodeCommandArgAsUInt32(addressV);
    e.encodeCommandArgAsUInt32(addressW);
    e.finishEncodingCommand();
}

/** `COMMAND_SETTEXTURE` — bind `texture` to a sampler `uniform` (native binds to
 *  the sampler uniform, not a texture unit). */
export function dSetTexture(engine: GLEngineContext, uniform: NativeUniform, texture: NativeTexture): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETTEXTURE);
    e.encodeCommandArgAsNativeData(uniform);
    e.encodeCommandArgAsNativeData(texture);
    e.finishEncodingCommand();
}

/** `COMMAND_UNSETTEXTURE` — clear the texture bound to a sampler `uniform`. */
export function dUnsetTexture(engine: GLEngineContext, uniform: NativeUniform): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_UNSETTEXTURE);
    e.encodeCommandArgAsNativeData(uniform);
    e.finishEncodingCommand();
}

/** Release a texture. `deleteTexture` is an IMMEDIATE host call (unlike the
 *  streamed deletes), so commands already queued in an open frame scope that
 *  reference the texture are submitted first. */
export function dDeleteTexture(engine: GLEngineContext, texture: NativeTexture): void {
    engine._encoder.submitPending();
    engine._engine.deleteTexture(texture);
}

/** Texture width in texels. */
export function dGetTextureWidth(engine: GLEngineContext, texture: NativeTexture): number {
    return engine._engine.getTextureWidth(texture);
}

/** Texture height in texels. */
export function dGetTextureHeight(engine: GLEngineContext, texture: NativeTexture): number {
    return engine._engine.getTextureHeight(texture);
}

/** GPU-side copy of `source`'s pixels into `destination` (`COMMAND_COPYTEXTURE`).
 *  Both are native texture handles of matching size/format. Used by the dynamic /
 *  html-element texture upload to blit a native canvas's backing texture into a
 *  sampleable texture without a CPU round-trip (mirrors ThinNativeEngine's
 *  `updateDynamicTexture`). */
export function dCopyTexture(engine: GLEngineContext, source: NativeTexture, destination: NativeTexture): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_COPYTEXTURE);
    e.encodeCommandArgAsNativeData(source);
    e.encodeCommandArgAsNativeData(destination);
    e.finishEncodingCommand();
}

/** Read back a `width`×`height` region of `texture` at `mipLevel`, origin
 *  (`x`,`y`). Native readback is ASYNCHRONOUS (bgfx copies on a later frame), so
 *  this resolves with the pixel `ArrayBuffer` — there is no synchronous native
 *  equivalent of `gl.readPixels`. Pass a preallocated `buffer`
 *  (+`bufferOffset`/`bufferLength`) to reuse storage, or `null` to have the host
 *  allocate. Mirrors ThinNativeEngine's `_readTexturePixels`. */
export function dReadTexture(
    engine: GLEngineContext,
    texture: NativeTexture,
    mipLevel: number,
    x: number,
    y: number,
    width: number,
    height: number,
    buffer: ArrayBuffer | null,
    bufferOffset: number,
    bufferLength: number
): Promise<ArrayBuffer> {
    return engine._engine.readTexture(texture, mipLevel, x, y, width, height, buffer, bufferOffset, bufferLength);
}

/* ─────────────────────────────  framebuffers  ─────────────────────────────── */

/** Create a framebuffer wrapping `texture` (+ optional depth/stencil). */
export function dCreateFramebuffer(
    engine: GLEngineContext,
    texture: NativeTexture | null,
    width: number,
    height: number,
    generateStencil: boolean,
    generateDepth: boolean
): NativeFramebuffer {
    return engine._engine.createFrameBuffer(texture, width, height, generateStencil, generateDepth, 1);
}

/** `COMMAND_BINDFRAMEBUFFER`. */
export function dBindFramebuffer(engine: GLEngineContext, framebuffer: NativeFramebuffer): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_BINDFRAMEBUFFER);
    e.encodeCommandArgAsNativeData(framebuffer);
    e.finishEncodingCommand();
}

/** `COMMAND_UNBINDFRAMEBUFFER`. */
export function dUnbindFramebuffer(engine: GLEngineContext, framebuffer: NativeFramebuffer): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_UNBINDFRAMEBUFFER);
    e.encodeCommandArgAsNativeData(framebuffer);
    e.finishEncodingCommand();
}

/** `COMMAND_DELETEFRAMEBUFFER`. */
export function dDeleteFramebuffer(engine: GLEngineContext, framebuffer: NativeFramebuffer): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_DELETEFRAMEBUFFER);
    e.encodeCommandArgAsNativeData(framebuffer);
    e.finishEncodingCommand();
}

/* ─────────────────────────────  state  ────────────────────────────────────── */

/** Set the backbuffer viewport (immediate — not command-streamed, matching
 *  ThinNativeEngine.setViewport which uses `COMMAND_SETVIEWPORT`). */
export function dSetViewport(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETVIEWPORT);
    e.encodeCommandArgAsFloat32(x);
    e.encodeCommandArgAsFloat32(y);
    e.encodeCommandArgAsFloat32(width);
    e.encodeCommandArgAsFloat32(height);
    e.finishEncodingCommand();
}

/** `COMMAND_SETSCISSOR`. Passing all-zero disables the scissor test (matching
 *  ThinNativeEngine.disableScissor). */
export function dSetScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETSCISSOR);
    e.encodeCommandArgAsFloat32(x);
    e.encodeCommandArgAsFloat32(y);
    e.encodeCommandArgAsFloat32(width);
    e.encodeCommandArgAsFloat32(height);
    e.finishEncodingCommand();
}

/** `COMMAND_SETBLENDMODE` with a native `ALPHA_*` preset. */
export function dSetBlendMode(engine: GLEngineContext, nativeAlphaMode: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETBLENDMODE);
    e.encodeCommandArgAsUInt32(nativeAlphaMode);
    e.finishEncodingCommand();
}

/** `COMMAND_SETDEPTHTEST` — encodes the compare func, or `DEPTH_TEST_ALWAYS`
 *  when depth testing is disabled (native conflates the two). */
export function dSetDepthTest(engine: GLEngineContext, depthTest: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETDEPTHTEST);
    e.encodeCommandArgAsUInt32(depthTest);
    e.finishEncodingCommand();
}

/** `COMMAND_SETDEPTHWRITE`. */
export function dSetDepthWrite(engine: GLEngineContext, enabled: boolean): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETDEPTHWRITE);
    e.encodeCommandArgAsUInt32(enabled ? 1 : 0);
    e.finishEncodingCommand();
}

/** `COMMAND_SETCOLORWRITE`. */
export function dSetColorWrite(engine: GLEngineContext, enabled: boolean): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETCOLORWRITE);
    e.encodeCommandArgAsUInt32(enabled ? 1 : 0);
    e.finishEncodingCommand();
}

/** `COMMAND_SETSTATE` — face culling (lite-gl uses no polygon offset / reverse).
 *  `cullBack` selects back-face (true) vs front-face culling. */
export function dSetCull(engine: GLEngineContext, enabled: boolean, cullBack: boolean): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETSTATE);
    e.encodeCommandArgAsUInt32(enabled ? 1 : 0);
    e.encodeCommandArgAsFloat32(0);
    e.encodeCommandArgAsFloat32(0);
    e.encodeCommandArgAsUInt32(cullBack ? 1 : 0);
    e.encodeCommandArgAsUInt32(0);
    e.finishEncodingCommand();
}

/** `COMMAND_SETSTENCIL` (mask, op-fail, op-zfail, op-zpass, func, ref). Values
 *  are native `STENCIL_*` enums (mapped by the caller). */
export function dSetStencil(engine: GLEngineContext, mask: number, opFail: number, opZFail: number, opZPass: number, func: number, ref: number): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_SETSTENCIL);
    e.encodeCommandArgAsUInt32(mask);
    e.encodeCommandArgAsUInt32(opFail);
    e.encodeCommandArgAsUInt32(opZFail);
    e.encodeCommandArgAsUInt32(opZPass);
    e.encodeCommandArgAsUInt32(func);
    e.encodeCommandArgAsUInt32(ref);
    e.finishEncodingCommand();
}

/** `COMMAND_CLEAR` (matches ThinNativeEngine.clear's arg layout). */
export function dClear(
    engine: GLEngineContext,
    r: number,
    g: number,
    b: number,
    a: number,
    clearColor: boolean,
    clearDepth: boolean,
    clearStencil: boolean,
    stencilValue: number
): void {
    const e = engine._encoder;
    e.startEncodingCommand(_native.Engine.COMMAND_CLEAR);
    e.encodeCommandArgAsUInt32(clearColor ? 1 : 0);
    e.encodeCommandArgAsFloat32(r);
    e.encodeCommandArgAsFloat32(g);
    e.encodeCommandArgAsFloat32(b);
    e.encodeCommandArgAsFloat32(a);
    e.encodeCommandArgAsUInt32(clearDepth ? 1 : 0);
    e.encodeCommandArgAsFloat32(1);
    e.encodeCommandArgAsUInt32(clearStencil ? 1 : 0);
    e.encodeCommandArgAsUInt32(stencilValue);
    e.finishEncodingCommand();
}

/* ─────────────────────────  enum mapping helpers  ─────────────────────────── */

/** Map a lite-gl {@link GLBlendMode} preset (0/1/2/7) to a native `ALPHA_*`. */
export function nativeAlphaMode(mode: number): number {
    switch (mode) {
        case 1:
            return _native.Engine.ALPHA_ADD;
        case 2:
            return _native.Engine.ALPHA_COMBINE;
        case 7:
            return _native.Engine.ALPHA_PREMULTIPLIED;
        default:
            return _native.Engine.ALPHA_DISABLE;
    }
}

/** Map WebGL `TEXTURE_MIN_FILTER` / `TEXTURE_MAG_FILTER` enums to the native
 *  `TEXTURE_<MAG>_<MIN>[_MIP<MIP>]` sampling enum. Every WebGL min/mag pair has
 *  an exact native equivalent. */
export function nativeFilter(minFilter: number, magFilter: number): number {
    const E = _native.Engine;
    const magLinear = magFilter !== 0x2600; // NEAREST
    switch (minFilter) {
        case 0x2600: // NEAREST
            return magLinear ? E.TEXTURE_LINEAR_NEAREST : E.TEXTURE_NEAREST_NEAREST;
        case 0x2700: // NEAREST_MIPMAP_NEAREST
            return magLinear ? E.TEXTURE_LINEAR_NEAREST_MIPNEAREST : E.TEXTURE_NEAREST_NEAREST_MIPNEAREST;
        case 0x2701: // LINEAR_MIPMAP_NEAREST
            return magLinear ? E.TEXTURE_LINEAR_LINEAR_MIPNEAREST : E.TEXTURE_NEAREST_LINEAR_MIPNEAREST;
        case 0x2702: // NEAREST_MIPMAP_LINEAR
            return magLinear ? E.TEXTURE_LINEAR_NEAREST_MIPLINEAR : E.TEXTURE_NEAREST_NEAREST_MIPLINEAR;
        case 0x2703: // LINEAR_MIPMAP_LINEAR
            return magLinear ? E.TEXTURE_LINEAR_LINEAR_MIPLINEAR : E.TEXTURE_NEAREST_LINEAR_MIPLINEAR;
        default: // LINEAR
            return magLinear ? E.TEXTURE_LINEAR_LINEAR : E.TEXTURE_NEAREST_LINEAR;
    }
}

/** Map a lite-gl wrap constant to a native `ADDRESS_MODE_*`. Accepts the WebGL
 *  enum values lite-gl uses (`CLAMP_TO_EDGE` 0x812f, `REPEAT` 0x2901,
 *  `MIRRORED_REPEAT` 0x8370). */
export function nativeAddressMode(wrap: number): number {
    switch (wrap) {
        case 0x2901: // REPEAT
            return _native.Engine.ADDRESS_MODE_WRAP;
        case 0x8370: // MIRRORED_REPEAT
            return _native.Engine.ADDRESS_MODE_MIRROR;
        default: // CLAMP_TO_EDGE
            return _native.Engine.ADDRESS_MODE_CLAMP;
    }
}
