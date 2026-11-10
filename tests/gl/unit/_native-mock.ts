/**
 * Minimal mock of the Babylon Native `_native` global for lite-gl native-backend
 * unit tests. Records every engine method call, and captures the raw uint32 words
 * the command encoder flushes through the data stream so tests can assert that
 * the expected `COMMAND_*` tags were emitted.
 *
 * Command tags are distinct large sentinels (1000+) so a search for a tag value
 * in the encoded word stream cannot collide with small numeric args.
 */

export interface NativeCall {
    name: string;
    args: unknown[];
}

export interface MockNative {
    /** Install `globalThis._native = this.native`. */
    install(): void;
    /** Restore the previous global. */
    uninstall(): void;
    /** Recorded direct engine method calls (createVertexBuffer, getUniforms, …). */
    calls: NativeCall[];
    /** All uint32 words flushed through the command data stream, in order. */
    streamWords: number[];
    /** The SAME flushed words reinterpreted as float32, index-aligned with
     *  {@link streamWords} (both arrays are pushed from the same buffer position
     *  in lockstep), so a test can read a float32 command argument at the same
     *  index a uint32/int32 argument would occupy in `streamWords`. */
    streamFloats: number[];
    /** Trigger the pending program-compile success callbacks (async link done). */
    fireProgramReady(): void;
    /** Trigger the pending program-compile ERROR callbacks with `message`. */
    fireProgramError(message: string): void;
    /** Complete pending host `loadTexture` decodes (`ok` → success, else error). */
    fireTextureLoads(ok?: boolean): void;
    /** Native-handle id (`handle[0]`) of every `deleteTexture` call, in order. */
    deletedTextures: number[];
    /** Args of every `readTexture` call. */
    readTextureCalls: unknown[][];
    /** Byte pattern `readTexture` fills its RGBA8 result with (default: byte index & 0xff). */
    readPattern: (byteIndex: number) => number;
    /** Float pattern `readTexture2` fills its RGBA32F result with for float
     *  sources (`host: "current"` only; default: element index / 4). */
    readFloatPattern: (elementIndex: number) => number;
    /** GPU time `populateFrameStats` reports (`undefined` → 0 ns). */
    frameStats?: { gpuTimeNs?: number };
    /** Trigger the last requestAnimationFrame callback. */
    fireAnimationFrame(): void;
    /** Trigger the bgfx device-restore (render-reset) callback. */
    fireDeviceRestore(): void;
    /** Count how many times an engine method was called. */
    count(name: string): number;
    /** True if the encoded stream contains the given command-tag value. */
    streamHasCommand(tagValue: number): boolean;
    /** The command-tag sentinel value for a `COMMAND_*` name. */
    tag(name: string): number;
}

/**
 * The mock's model of the low-level `_native.NativeDataStream` object — the raw
 * native stream instance the host reads command bytes FROM (via `writeBuffer`,
 * called by the JS `NativeDataStream` class) and that the mock HOST calls back
 * INTO (via `__requestFlush`, the `requestFlushCallback` ctor argument) to ask
 * JS to drain its buffer. This is intentionally distinct from the JS wrapper
 * object (which merely carries a `_nativeDataStream` property pointing at one of
 * these) — see the ABI-enforcement comment on `setCommandDataStream` below.
 */
interface MockRawNativeStream {
    /** @internal The `requestFlushCallback` passed to the ctor; invoked by the
     *  mock host (never by JS) to request a flush, mirroring the real host. */
    __requestFlush: () => void;
    /** Called BY the JS `NativeDataStream` class to hand over encoded bytes. */
    writeBuffer: (buffer: ArrayBuffer, length: number) => void;
}

function isMockRawNativeStream(value: unknown): value is MockRawNativeStream {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const v = value as Partial<MockRawNativeStream>;
    return typeof v.writeBuffer === "function" && typeof v.__requestFlush === "function";
}

/** Options for {@link createMockNative}. */
export interface MockNativeOptions {
    /** `"legacy"` (default) models an older Babylon Native host. `"current"`
     *  models current Babylon Native master, which adds `COMMAND_SETSTENCIL2`,
     *  `COMMAND_SETBLENDEQUATION`, `COMMAND_GENERATEMIPMAPS`, the
     *  `ALPHA_ONEONE_ONEONE` / `ALPHA_LAYER_ACCUMULATE` presets, the
     *  `ALPHA_EQUATION_*` values, `readTexture2` (RGBA32F for float sources) and
     *  `loadRawTexture3D`. */
    host?: "legacy" | "current";
}

/** Build the mock. Call {@link MockNative.install} before creating a native engine. */
export function createMockNative(options: MockNativeOptions = {}): MockNative {
    const current = options.host === "current";
    const calls: NativeCall[] = [];
    const streamWords: number[] = [];
    const streamFloats: number[] = [];
    const readyCallbacks: (() => void)[] = [];
    const errorCallbacks: ((e: Error) => void)[] = [];
    const textureLoads: { ok: () => void; fail: () => void }[] = [];
    const deletedTextures: number[] = [];
    const readTextureCalls: unknown[][] = [];
    const textureSizes = new Map<number, { w: number; h: number }>();
    const textureFormats = new Map<number, number>();
    const rafCallbacks: (() => void)[] = [];
    // Stored so a test can simulate a bgfx device-restore edge.
    let renderResetCb: (() => void) | null = null;
    let handleSeq = 1;
    const newHandle = (): Uint32Array => new Uint32Array([handleSeq++]);

    const rec = (name: string, ...args: unknown[]): void => {
        calls.push({ name, args });
    };

    const commandNames = [
        "COMMAND_DELETEVERTEXARRAY",
        "COMMAND_DELETEINDEXBUFFER",
        "COMMAND_DELETEVERTEXBUFFER",
        "COMMAND_SETPROGRAM",
        "COMMAND_DELETEPROGRAM",
        "COMMAND_SETMATRIX",
        "COMMAND_SETMATRIX3X3",
        "COMMAND_SETMATRICES",
        "COMMAND_SETINT",
        "COMMAND_SETINTARRAY",
        "COMMAND_SETFLOAT",
        "COMMAND_SETFLOAT2",
        "COMMAND_SETFLOAT3",
        "COMMAND_SETFLOAT4",
        "COMMAND_SETFLOATARRAY",
        "COMMAND_SETFLOATARRAY4",
        "COMMAND_SETTEXTURE",
        "COMMAND_UNSETTEXTURE",
        "COMMAND_COPYTEXTURE",
        "COMMAND_SETTEXTURESAMPLING",
        "COMMAND_SETTEXTUREWRAPMODE",
        "COMMAND_BINDVERTEXARRAY",
        "COMMAND_SETSTATE",
        "COMMAND_SETDEPTHTEST",
        "COMMAND_SETDEPTHWRITE",
        "COMMAND_SETCOLORWRITE",
        "COMMAND_SETBLENDMODE",
        "COMMAND_SETSTENCIL",
        "COMMAND_SETVIEWPORT",
        "COMMAND_SETSCISSOR",
        "COMMAND_BINDFRAMEBUFFER",
        "COMMAND_UNBINDFRAMEBUFFER",
        "COMMAND_DELETEFRAMEBUFFER",
        "COMMAND_DRAWINDEXED",
        "COMMAND_DRAWINDEXEDINSTANCED",
        "COMMAND_CLEAR",
    ];
    if (current) {
        commandNames.push("COMMAND_SETSTENCIL2", "COMMAND_SETBLENDEQUATION", "COMMAND_GENERATEMIPMAPS");
    }
    const tagValues: Record<string, number> = {};
    const engineStatics: Record<string, unknown> = {
        PROTOCOL_VERSION: 9,
        CAPS_LIMITS_MAX_TEXTURE_SIZE: 8192,
        CAPS_LIMITS_MAX_TEXTURE_LAYERS: 2048,
        TEXTURE_NEAREST_NEAREST: 1,
        TEXTURE_LINEAR_LINEAR: 2,
        TEXTURE_LINEAR_LINEAR_MIPLINEAR: 3,
        TEXTURE_NEAREST_NEAREST_MIPNEAREST: 4,
        TEXTURE_NEAREST_LINEAR: 5,
        TEXTURE_LINEAR_NEAREST: 100,
        TEXTURE_NEAREST_LINEAR_MIPNEAREST: 101,
        TEXTURE_NEAREST_LINEAR_MIPLINEAR: 102,
        TEXTURE_NEAREST_NEAREST_MIPLINEAR: 103,
        TEXTURE_LINEAR_NEAREST_MIPNEAREST: 104,
        TEXTURE_LINEAR_NEAREST_MIPLINEAR: 105,
        TEXTURE_LINEAR_LINEAR_MIPNEAREST: 106,
        ADDRESS_MODE_WRAP: 10,
        ADDRESS_MODE_MIRROR: 11,
        ADDRESS_MODE_CLAMP: 12,
        ATTRIB_TYPE_FLOAT: 20,
        ALPHA_DISABLE: 0,
        ALPHA_ADD: 1,
        ALPHA_COMBINE: 2,
        ALPHA_PREMULTIPLIED: 7,
        ALPHA_SUBTRACT: 3,
        ALPHA_MULTIPLY: 4,
        ALPHA_MAXIMIZED: 5,
        ALPHA_ONEONE: 6,
        ALPHA_PREMULTIPLIED_PORTERDUFF: 8,
        ALPHA_SCREENMODE: 10,
        TEXTURE_FORMAT_RGBA8: 30,
        TEXTURE_FORMAT_RGBA32F: 31,
        TEXTURE_FORMAT_RGBA16F: 32,
        TEXTURE_FORMAT_R8: 33,
        TEXTURE_FORMAT_RG8: 34,
        TEXTURE_FORMAT_RGB8: 35,
        TEXTURE_FORMAT_R16F: 36,
        TEXTURE_FORMAT_R32F: 37,
        TEXTURE_FORMAT_RG16F: 38,
        TEXTURE_FORMAT_RG32F: 39,
        TEXTURE_FORMAT_RG32U: 29,
        DEPTH_TEST_LESS: 40,
        DEPTH_TEST_ALWAYS: 41,
        DEPTH_TEST_LEQUAL: 42,
        DEPTH_TEST_EQUAL: 43,
        DEPTH_TEST_GEQUAL: 44,
        DEPTH_TEST_GREATER: 45,
        DEPTH_TEST_NOTEQUAL: 46,
        DEPTH_TEST_NEVER: 47,
        STENCIL_TEST_LESS: 50,
        STENCIL_TEST_LEQUAL: 51,
        STENCIL_TEST_EQUAL: 52,
        STENCIL_TEST_GEQUAL: 53,
        STENCIL_TEST_GREATER: 54,
        STENCIL_TEST_NOTEQUAL: 55,
        STENCIL_TEST_NEVER: 56,
        STENCIL_TEST_ALWAYS: 57,
        STENCIL_OP_FAIL_S_KEEP: 60,
        STENCIL_OP_FAIL_S_ZERO: 61,
        STENCIL_OP_FAIL_S_REPLACE: 62,
        STENCIL_OP_FAIL_S_INCR: 63,
        STENCIL_OP_FAIL_S_DECR: 64,
        STENCIL_OP_FAIL_S_INVERT: 65,
        STENCIL_OP_FAIL_Z_KEEP: 70,
        STENCIL_OP_FAIL_Z_ZERO: 71,
        STENCIL_OP_FAIL_Z_REPLACE: 72,
        STENCIL_OP_FAIL_Z_INCR: 73,
        STENCIL_OP_FAIL_Z_DECR: 74,
        STENCIL_OP_FAIL_Z_INVERT: 75,
        STENCIL_OP_PASS_Z_KEEP: 80,
        STENCIL_OP_PASS_Z_ZERO: 81,
        STENCIL_OP_PASS_Z_REPLACE: 82,
        STENCIL_OP_PASS_Z_INCR: 83,
        STENCIL_OP_PASS_Z_DECR: 84,
        STENCIL_OP_PASS_Z_INVERT: 85,
    };
    if (current) {
        Object.assign(engineStatics, {
            ALPHA_ONEONE_ONEONE: 11,
            ALPHA_LAYER_ACCUMULATE: 17,
            ALPHA_EQUATION_ADD: 0,
            ALPHA_EQUATION_SUBTRACT: 1,
            ALPHA_EQUATION_REVERSE_SUBTRACT: 2,
            ALPHA_EQUATION_MAX: 3,
            ALPHA_EQUATION_MIN: 4,
            ALPHA_EQUATION_DARKEN: 5,
        });
    }
    const floatFormats = new Set([31, 32, 36, 37, 38, 39]);
    let tagSeq = 1000;
    for (const name of commandNames) {
        const value = tagSeq++;
        tagValues[name] = value;
        engineStatics[name] = new Uint32Array([value]);
    }

    /**
     * Build one `_native.Engine` instance. Each instance owns its OWN bound
     * command stream (`boundStream`), resolved ONLY through the
     * `setCommandDataStream` ABI-unwrap below — `submitCommands` drains
     * precisely that stream, never a module-wide fallback. This is what makes
     * the mock a faithful (rather than a rubber-stamp) model of the host
     * contract: if the wrong object ever reaches `setCommandDataStream`,
     * commands silently stop flowing (or the call throws outright), instead of
     * the test suite happening to still pass because SOME stream got wired up
     * via a side channel.
     */
    const makeEngineInstance = (): Record<string, unknown> => {
        let boundStream: MockRawNativeStream | null = null;

        return {
            dispose: () => rec("dispose"),
            requestAnimationFrame: (cb: () => void) => {
                rec("requestAnimationFrame");
                rafCallbacks.push(cb);
            },
            setRenderResetCallback: (cb: () => void) => {
                rec("setRenderResetCallback");
                renderResetCb = cb;
            },
            createVertexArray: () => {
                rec("createVertexArray");
                return newHandle();
            },
            createIndexBuffer: (...a: unknown[]) => {
                rec("createIndexBuffer", ...a);
                return newHandle();
            },
            recordIndexBuffer: (...a: unknown[]) => rec("recordIndexBuffer", ...a),
            updateDynamicIndexBuffer: (...a: unknown[]) => rec("updateDynamicIndexBuffer", ...a),
            createVertexBuffer: (...a: unknown[]) => {
                rec("createVertexBuffer", ...a);
                return newHandle();
            },
            recordVertexBuffer: (...a: unknown[]) => rec("recordVertexBuffer", ...a),
            updateDynamicVertexBuffer: (...a: unknown[]) => rec("updateDynamicVertexBuffer", ...a),
            createProgram: (...a: unknown[]) => {
                rec("createProgram", ...a);
                return newHandle();
            },
            createProgramAsync: (vs: string, fs: string, onSuccess: () => void, onError: (e: Error) => void) => {
                rec("createProgramAsync", vs, fs);
                readyCallbacks.push(onSuccess);
                errorCallbacks.push(onError);
                return newHandle();
            },
            getUniforms: (_p: unknown, names: string[]) => {
                rec("getUniforms", names.slice());
                return names.map(() => newHandle());
            },
            getAttributes: (_p: unknown, names: string[]) => {
                rec("getAttributes", names.slice());
                return names.map((_n, i) => i);
            },
            createTexture: () => {
                rec("createTexture");
                return newHandle();
            },
            initializeTexture: (...a: unknown[]) => {
                rec("initializeTexture", ...a);
                textureSizes.set((a[0] as Uint32Array)[0]!, { w: a[1] as number, h: a[2] as number });
                textureFormats.set((a[0] as Uint32Array)[0]!, a[4] as number);
            },
            loadTexture: (...a: unknown[]) => {
                rec("loadTexture", ...a);
                const handle = (a[0] as Uint32Array)[0]!;
                textureLoads.push({
                    ok: () => {
                        textureSizes.set(handle, { w: 4, h: 4 });
                        (a[5] as () => void)();
                    },
                    fail: () => (a[6] as () => void)(),
                });
            },
            loadRawTexture: (...a: unknown[]) => {
                rec("loadRawTexture", ...a);
                textureSizes.set((a[0] as Uint32Array)[0]!, { w: a[2] as number, h: a[3] as number });
            },
            updateTextureData: (...a: unknown[]) => rec("updateTextureData", ...a),
            getTextureWidth: (t: Uint32Array) => textureSizes.get(t[0]!)?.w ?? 4,
            getTextureHeight: (t: Uint32Array) => textureSizes.get(t[0]!)?.h ?? 4,
            deleteTexture: (...a: unknown[]) => {
                rec("deleteTexture", ...a);
                deletedTextures.push((a[0] as Uint32Array)[0]!);
            },
            // Host contract: always returns RGBA8 (w*h*4 bytes), regardless of the
            // texture format, and runs immediately.
            readTexture: (...a: unknown[]) => {
                rec("readTexture", ...a);
                readTextureCalls.push(a);
                const w = a[4] as number;
                const h = a[5] as number;
                const out = new Uint8Array(w * h * 4);
                for (let i = 0; i < out.length; i++) {
                    out[i] = mockApi.readPattern(i);
                }
                return Promise.resolve(out.buffer);
            },
            ...(current
                ? {
                      // Host contract: RGBA32F for float sources, RGBA8 otherwise.
                      readTexture2: (...a: unknown[]) => {
                          rec("readTexture2", ...a);
                          readTextureCalls.push(a);
                          const w = a[4] as number;
                          const h = a[5] as number;
                          if (floatFormats.has(textureFormats.get((a[0] as Uint32Array)[0]!) ?? -1)) {
                              const out = new Float32Array(w * h * 4);
                              for (let i = 0; i < out.length; i++) {
                                  out[i] = mockApi.readFloatPattern(i);
                              }
                              return Promise.resolve(out.buffer);
                          }
                          const out = new Uint8Array(w * h * 4);
                          for (let i = 0; i < out.length; i++) {
                              out[i] = mockApi.readPattern(i);
                          }
                          return Promise.resolve(out.buffer);
                      },
                      loadRawTexture3D: (...a: unknown[]) => rec("loadRawTexture3D", ...a),
                  }
                : {}),
            createImageBitmap: (data: ArrayBuffer) => {
                rec("createImageBitmap", data);
                return { data: new Uint8Array([10, 20, 30, 128, 40, 50, 60, 255, 70, 80, 90, 0, 1, 2, 3, 64]), width: 2, height: 2, format: engineStatics.TEXTURE_FORMAT_RGBA8 };
            },
            populateFrameStats: (stats: { gpuTimeNs?: number }) => {
                rec("populateFrameStats");
                stats.gpuTimeNs = mockApi.frameStats?.gpuTimeNs ?? 0;
            },
            createFrameBuffer: (...a: unknown[]) => {
                rec("createFrameBuffer", ...a);
                return newHandle();
            },
            getRenderWidth: () => 256,
            getRenderHeight: () => 256,
            setHardwareScalingLevel: (...a: unknown[]) => rec("setHardwareScalingLevel", ...a),
            setViewPort: (...a: unknown[]) => rec("setViewPort", ...a),
            /**
             * HOST ABI CONTRACT (mirrors NativeEngine.cpp): the host receives the JS
             * `NativeDataStream` WRAPPER and reads the raw stream off its
             * `_nativeDataStream` property by that EXACT name — it does not accept
             * the raw stream directly, and it does not accept any other shape. A
             * production regression that passes `this._stream._nativeDataStream`
             * (the raw stream) instead of `this._stream` (the wrapper) — or any
             * other object lacking a valid `_nativeDataStream` — MUST be caught
             * here rather than silently "working" because some other code path
             * happens to still move bytes.
             */
            setCommandDataStream: (wrapper: unknown) => {
                rec("setCommandDataStream", wrapper);
                const unwrapped = (wrapper as { _nativeDataStream?: unknown } | null | undefined)?._nativeDataStream;
                if (!isMockRawNativeStream(unwrapped)) {
                    throw new Error(
                        "mock native host: setCommandDataStream requires the JS wrapper's `_nativeDataStream` property " +
                            '(host ABI contract — NativeEngine.cpp `Get("_nativeDataStream")`). Received an object that does ' +
                            "not expose a valid native stream at that property — passing the raw NativeDataStream instance " +
                            "directly (instead of its wrapper), or any other shape, is REJECTED, not silently accepted."
                    );
                }
                boundStream = unwrapped;
            },
            submitCommands: () => {
                if (boundStream === null) {
                    throw new Error("mock native host: submitCommands called before a valid command data stream was installed via setCommandDataStream");
                }
                // Native drains the command buffer here — request a flush from
                // EXACTLY the stream that was validly bound, so encoded words reach
                // writeBuffer only through the ABI-correct path (matching the real
                // host, and catching a wrong-object regression above instead of here).
                boundStream.__requestFlush();
                rec("submitCommands");
            },
        };
    };

    const engineCtor = function (info: unknown): Record<string, unknown> {
        rec("new Engine", info);
        return makeEngineInstance();
    } as unknown as { new (info: unknown): unknown } & Record<string, unknown>;
    Object.assign(engineCtor, engineStatics);

    const dataStreamCtor = function (this: MockRawNativeStream, cb: () => void): void {
        // `cb` is the `requestFlushCallback`: per the real ABI (see
        // INativeDataStreamConstructor), the HOST invokes it to ask JS to drain its
        // buffer — it is never called by JS itself. Store it under a name that
        // cannot be confused with the public `writeBuffer` (which JS DOES call).
        this.__requestFlush = cb;
        this.writeBuffer = (buffer: ArrayBuffer, length: number): void => {
            const words = new Uint32Array(buffer, 0, length);
            const floats = new Float32Array(buffer, 0, length);
            for (let i = 0; i < length; i++) {
                streamWords.push(words[i]!);
                streamFloats.push(floats[i]!);
            }
        };
    } as unknown as new (cb: () => void) => MockRawNativeStream;

    const native = { Engine: engineCtor, NativeDataStream: dataStreamCtor };
    let previous: unknown;

    const mockApi: MockNative = {
        calls,
        streamWords,
        streamFloats,
        deletedTextures,
        readTextureCalls,
        readPattern: (i) => i & 0xff,
        readFloatPattern: (i) => i / 4,
        install(): void {
            previous = (globalThis as { _native?: unknown })._native;
            (globalThis as { _native?: unknown })._native = native;
        },
        uninstall(): void {
            (globalThis as { _native?: unknown })._native = previous;
        },
        fireProgramReady(): void {
            const pending = readyCallbacks.slice();
            readyCallbacks.length = 0;
            errorCallbacks.length = 0;
            for (const cb of pending) {
                cb();
            }
        },
        fireProgramError(message: string): void {
            const pending = errorCallbacks.slice();
            errorCallbacks.length = 0;
            readyCallbacks.length = 0;
            for (const cb of pending) {
                cb(new Error(message));
            }
        },
        fireTextureLoads(ok = true): void {
            const pending = textureLoads.slice();
            textureLoads.length = 0;
            for (const load of pending) {
                if (ok) {
                    load.ok();
                } else {
                    load.fail();
                }
            }
        },
        fireAnimationFrame(): void {
            const cb = rafCallbacks.shift();
            if (cb) {
                cb();
            }
        },
        fireDeviceRestore(): void {
            renderResetCb?.();
        },
        count: (name) => calls.reduce((acc, c) => acc + (c.name === name ? 1 : 0), 0),
        streamHasCommand: (tagValue) => streamWords.indexOf(tagValue) !== -1,
        tag: (name) => tagValues[name]!,
    };
    return mockApi;
}
