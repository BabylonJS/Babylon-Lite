/** @internal */
export type NativeHandle = Uint32Array<ArrayBuffer>;

/** @internal */
export interface NativeEngine {
    dispose(): void;
    setRenderResetCallback(callback: () => void): void;
    setHardwareScalingLevel(level: number): void;
    getRenderWidth(): number;
    getRenderHeight(): number;
    setCommandDataStream(stream: object): void;
    submitCommands(): void;
    createProgram(vertex: string, fragment: string): NativeHandle;
    getUniforms(program: NativeHandle, names: string[]): (NativeHandle | null)[];
    getAttributes(program: NativeHandle, names: string[]): number[];
    createVertexArray(): NativeHandle;
    createVertexBuffer(data: ArrayBufferLike, offset: number, length: number, dynamic: boolean): NativeHandle;
    createIndexBuffer(data: ArrayBufferLike, offset: number, length: number, is32Bits: boolean, dynamic: boolean): NativeHandle;
    recordIndexBuffer(vao: NativeHandle, buffer: NativeHandle): void;
    recordVertexBuffer(
        vao: NativeHandle,
        buffer: NativeHandle,
        location: number,
        offset: number,
        stride: number,
        components: number,
        type: number,
        normalized: boolean,
        divisor: number
    ): void;
    createTexture(): NativeHandle;
    loadRawTexture(handle: NativeHandle, data: ArrayBufferView, width: number, height: number, format: number, mipmaps: boolean, invertY: boolean): void;
    initializeTexture(handle: NativeHandle, width: number, height: number, mipmaps: boolean, format: number, renderTarget: boolean, srgb: boolean, samples: number): void;
    getTextureWidth(handle: NativeHandle): number;
    getTextureHeight(handle: NativeHandle): number;
    deleteTexture(handle: NativeHandle): void;
    createFrameBuffer(texture: NativeHandle, width: number, height: number, stencil: boolean, depth: boolean, samples: number): NativeHandle;
}

type CommandName =
    | "SETPROGRAM"
    | "DELETEPROGRAM"
    | "SETFLOAT"
    | "SETFLOAT2"
    | "SETFLOAT3"
    | "SETFLOAT4"
    | "SETINT"
    | "SETFLOATARRAY"
    | "SETFLOATARRAY2"
    | "SETFLOATARRAY3"
    | "SETFLOATARRAY4"
    | "SETMATRICES"
    | "SETTEXTURE"
    | "SETTEXTURESAMPLING"
    | "SETTEXTUREWRAPMODE"
    | "SETTEXTUREANISOTROPICLEVEL"
    | "DELETEVERTEXBUFFER"
    | "DELETEINDEXBUFFER"
    | "DELETEVERTEXARRAY"
    | "BINDVERTEXARRAY"
    | "DRAWINDEXED"
    | "BINDFRAMEBUFFER"
    | "UNBINDFRAMEBUFFER"
    | "DELETEFRAMEBUFFER"
    | "SETVIEWPORT"
    | "SETSCISSOR"
    | "SETBLENDMODE"
    | "SETDEPTHTEST"
    | "SETDEPTHWRITE"
    | "SETSTATE"
    | "CLEAR";

/** @internal */
export type NativeEngineConstructor = {
    new (info: { version: string; nonFloatVertexBuffers: true }): NativeEngine;
    readonly PROTOCOL_VERSION: number;
    readonly CAPS_LIMITS_MAX_TEXTURE_SIZE: number;
    readonly ATTRIB_TYPE_FLOAT: number;
    readonly TEXTURE_FORMAT_RGBA8: number;
    readonly TEXTURE_LINEAR_LINEAR: number;
    readonly TEXTURE_NEAREST_NEAREST: number;
    readonly ADDRESS_MODE_CLAMP: number;
    readonly DEPTH_TEST_ALWAYS: number;
    readonly ALPHA_DISABLE: number;
    readonly ALPHA_COMBINE: number;
    readonly ALPHA_ADD: number;
    readonly ALPHA_PREMULTIPLIED: number;
} & { readonly [K in CommandName as `COMMAND_${K}`]: NativeHandle };

/** @internal */
export interface NativeDataStreamConstructor {
    new (flush: () => void): { writeBuffer(buffer: ArrayBuffer, words: number): void };
    readonly VALIDATION_ENABLED: boolean;
    readonly VALIDATION_UINT_32: number;
    readonly VALIDATION_INT_32: number;
    readonly VALIDATION_FLOAT_32: number;
    readonly VALIDATION_FLOAT_32_ARRAY: number;
    readonly VALIDATION_NATIVE_DATA: number;
    readonly VALIDATION_BOOLEAN: number;
}

/** @internal */
export interface NativeRuntime {
    Engine: NativeEngineConstructor;
    NativeDataStream: NativeDataStreamConstructor;
}

/** @internal */
export function getRuntime(): NativeRuntime {
    const runtime = (globalThis as typeof globalThis & { _native?: NativeRuntime })._native;
    if (!runtime) {
        throw new Error("Native Lite GL requires the Babylon Native runtime.");
    }
    if (runtime.Engine.PROTOCOL_VERSION !== 9) {
        throw new Error(`Native Lite GL requires protocol 9, received ${runtime.Engine.PROTOCOL_VERSION}.`);
    }
    return runtime;
}
