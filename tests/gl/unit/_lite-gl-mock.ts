/**
 * Minimal WebGL2 mock for lite-gl unit tests. Records every GL call into a
 * flat log so tests can assert cache elision. Only implements the subset of
 * gl.* the lite-gl package actually uses.
 *
 * NOTE: handles are returned as plain `{}` objects — referential identity is
 * what the cache uses.
 */

export interface MockCall {
    name: string;
    args: unknown[];
}

export interface MockCanvas extends HTMLCanvasElement {
    __glOverride: WebGL2RenderingContext | null;
    __listeners: { type: string; cb: EventListener }[];
}

export interface MockGL {
    gl: WebGL2RenderingContext;
    log: MockCall[];
    programs: { compileStatus: boolean; linkStatus: boolean; infoLog: string }[];
    /** Count GL calls of a specific name. */
    count(name: string): number;
    /** Clear the call log (useful between phases). */
    clear(): void;
    /** Set whether the next compile/link should succeed. */
    setCompileSuccess(ok: boolean): void;
    setLinkSuccess(ok: boolean): void;
    /** Mock parallel-shader-compile completion gate. Returns false until
     *  flipped via `setParallelComplete(true)`. */
    setParallelComplete(ok: boolean): void;
    setParallelAvailable(ok: boolean): void;
    /** Toggle availability of a `getExtension(name)` result (e.g. the
     *  color-buffer-float extensions that drive render-target caps). */
    setExtensionAvailable(name: string, ok: boolean): void;
}

interface Internal {
    parallelAvailable: boolean;
    parallelComplete: boolean;
    compileSuccess: boolean;
    linkSuccess: boolean;
    extensions: Record<string, boolean>;
}

export function createMockGL(): MockGL {
    const log: MockCall[] = [];
    const programs: MockGL["programs"] = [];
    const state: Internal = {
        parallelAvailable: true,
        parallelComplete: true,
        compileSuccess: true,
        linkSuccess: true,
        // Default: all color-buffer-float extensions present so render-target
        // float caps report true. Toggle with `setExtensionAvailable`.
        extensions: {
            EXT_color_buffer_float: true,
            EXT_color_buffer_half_float: true,
            OES_texture_float_linear: true,
        },
    };

    const PARALLEL_EXT = { COMPLETION_STATUS_KHR: 0x91b1 };

    const rec = (name: string, ...args: unknown[]): void => {
        log.push({ name, args });
    };

    const handle = (tag: string): object => ({ __tag: tag });

    // GL enums we use. Values mostly match real WebGL2 — they're opaque to the
    // package but tests sometimes assert specific arguments (e.g. TEXTURE0 + unit).
    const ENUMS: Record<string, number> = {
        ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893,
        STATIC_DRAW: 0x88e4,
        TRIANGLES: 0x0004,
        UNSIGNED_SHORT: 0x1403,
        UNSIGNED_BYTE: 0x1401,
        FLOAT: 0x1406,
        HALF_FLOAT: 0x140b,
        RGBA: 0x1908,
        RGB: 0x1907,
        RG: 0x8227,
        RED: 0x1903,
        LUMINANCE: 0x1909,
        RGBA8: 0x8058,
        RGB8: 0x8051,
        RG8: 0x822b,
        R8: 0x8229,
        RGBA32F: 0x8814,
        RGB32F: 0x8815,
        RGBA16F: 0x881a,
        RGB16F: 0x881b,
        TEXTURE_2D: 0x0de1,
        TEXTURE0: 0x84c0,
        TEXTURE_MIN_FILTER: 0x2801,
        TEXTURE_MAG_FILTER: 0x2800,
        TEXTURE_WRAP_S: 0x2802,
        TEXTURE_WRAP_T: 0x2803,
        LINEAR: 0x2601,
        LINEAR_MIPMAP_LINEAR: 0x2703,
        NEAREST: 0x2600,
        CLAMP_TO_EDGE: 0x812f,
        UNPACK_FLIP_Y_WEBGL: 0x9240,
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        MAX_TEXTURE_SIZE: 0x0d33,
        MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
        // ──── blend state + dynamic draw (sprites + setBlendMode) ────────
        BLEND: 0x0be2,
        FUNC_ADD: 0x8006,
        SRC_ALPHA: 0x0302,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        ONE: 1,
        ZERO: 0,
        DYNAMIC_DRAW: 0x88e8,
        UNSIGNED_INT: 0x1405,
        // ──── framebuffer / renderbuffer (render targets) ────────────────
        FRAMEBUFFER: 0x8d40,
        RENDERBUFFER: 0x8d41,
        COLOR_ATTACHMENT0: 0x8ce0,
        DEPTH_ATTACHMENT: 0x8d00,
        STENCIL_ATTACHMENT: 0x8d20,
        DEPTH_STENCIL_ATTACHMENT: 0x821a,
        DEPTH24_STENCIL8: 0x88f0,
        DEPTH_COMPONENT16: 0x81a5,
        STENCIL_INDEX8: 0x8d48,
        FRAMEBUFFER_COMPLETE: 0x8cd5,
        // ──── depth / stencil / cull / scissor / clear ───────────────────
        DEPTH_TEST: 0x0b71,
        STENCIL_TEST: 0x0b90,
        CULL_FACE: 0x0b44,
        SCISSOR_TEST: 0x0c11,
        COLOR_BUFFER_BIT: 0x4000,
        DEPTH_BUFFER_BIT: 0x0100,
        STENCIL_BUFFER_BIT: 0x0400,
        LESS: 0x0201,
        ALWAYS: 0x0207,
        NOTEQUAL: 0x0205,
        KEEP: 0x1e00,
        INCR_WRAP: 0x8507,
        BACK: 0x0405,
        // ──── pixel store + blend equations ──────────────────────────────
        UNPACK_ALIGNMENT: 0x0cf5,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
        MIN: 0x8007,
        MAX: 0x8008,
        FUNC_REVERSE_SUBTRACT: 0x800b,
        DST_COLOR: 0x0306,
        MIRRORED_REPEAT: 0x8370,
        REPEAT: 0x2901,
    };

    const gl = {
        ...ENUMS,
        // ──── context / caps ────────────────────────────────────────────
        getParameter: (p: number): number => {
            if (p === ENUMS.MAX_TEXTURE_SIZE) {
                return 4096;
            }
            if (p === ENUMS.MAX_COMBINED_TEXTURE_IMAGE_UNITS) {
                return 16;
            }
            return 0;
        },
        getExtension: (name: string): unknown => {
            if (name === "KHR_parallel_shader_compile" && state.parallelAvailable) {
                return PARALLEL_EXT;
            }
            if (state.extensions[name] === true) {
                return { __ext: name };
            }
            return null;
        },
        // ──── shaders / programs ────────────────────────────────────────
        createShader: (kind: number): object => {
            rec("createShader", kind);
            return handle("shader");
        },
        shaderSource: (s: object, src: string): void => {
            rec("shaderSource", s, src);
        },
        compileShader: (s: object): void => {
            rec("compileShader", s);
        },
        getShaderParameter: (_s: object, p: number): boolean => {
            if (p === ENUMS.COMPILE_STATUS) {
                return state.compileSuccess;
            }
            return false;
        },
        getShaderInfoLog: (): string => "mock compile error",
        deleteShader: (s: object): void => {
            rec("deleteShader", s);
        },
        createProgram: (): object => {
            const p = handle("program");
            programs.push({ compileStatus: true, linkStatus: state.linkSuccess, infoLog: "mock link error" });
            rec("createProgram");
            return p;
        },
        attachShader: (p: object, s: object): void => {
            rec("attachShader", p, s);
        },
        bindAttribLocation: (p: object, idx: number, name: string): void => {
            rec("bindAttribLocation", p, idx, name);
        },
        linkProgram: (p: object): void => {
            rec("linkProgram", p);
        },
        getProgramParameter: (_p: object, q: number): boolean | number => {
            if (q === ENUMS.LINK_STATUS) {
                return state.linkSuccess;
            }
            if (q === PARALLEL_EXT.COMPLETION_STATUS_KHR) {
                return state.parallelComplete;
            }
            return 0;
        },
        getProgramInfoLog: (): string => "mock link error",
        deleteProgram: (p: object): void => {
            rec("deleteProgram", p);
        },
        useProgram: (p: object | null): void => {
            rec("useProgram", p);
        },
        getUniformLocation: (_p: object, name: string): object | null => {
            // Treat any name as resolved unless it starts with `__missing_`.
            if (name.startsWith("__missing_")) {
                return null;
            }
            return { __tag: "uniform", name };
        },
        getAttribLocation: (_p: object, _name: string): number => 0,
        uniform1f: (loc: object, x: number): void => {
            rec("uniform1f", loc, x);
        },
        uniform2f: (loc: object, x: number, y: number): void => {
            rec("uniform2f", loc, x, y);
        },
        uniform3f: (loc: object, x: number, y: number, z: number): void => {
            rec("uniform3f", loc, x, y, z);
        },
        uniform4f: (loc: object, x: number, y: number, z: number, w: number): void => {
            rec("uniform4f", loc, x, y, z, w);
        },
        uniform1i: (loc: object, x: number): void => {
            rec("uniform1i", loc, x);
        },
        uniformMatrix4fv: (loc: object, transpose: boolean, value: unknown): void => {
            rec("uniformMatrix4fv", loc, transpose, value);
        },
        // ──── textures ─────────────────────────────────────────────────
        createTexture: (): object => {
            rec("createTexture");
            return handle("texture");
        },
        deleteTexture: (t: object): void => {
            rec("deleteTexture", t);
        },
        activeTexture: (u: number): void => {
            rec("activeTexture", u);
        },
        bindTexture: (target: number, t: object | null): void => {
            rec("bindTexture", target, t);
        },
        texImage2D: (...args: unknown[]): void => {
            rec("texImage2D", ...args);
        },
        texParameteri: (target: number, p: number, v: number): void => {
            rec("texParameteri", target, p, v);
        },
        generateMipmap: (target: number): void => {
            rec("generateMipmap", target);
        },
        pixelStorei: (k: number, v: number): void => {
            rec("pixelStorei", k, v);
        },
        // ──── buffers / VAO ────────────────────────────────────────────
        createBuffer: (): object => {
            rec("createBuffer");
            return handle("buffer");
        },
        deleteBuffer: (b: object): void => {
            rec("deleteBuffer", b);
        },
        bindBuffer: (target: number, b: object | null): void => {
            rec("bindBuffer", target, b);
        },
        bufferData: (...args: unknown[]): void => {
            rec("bufferData", ...args);
        },
        bufferSubData: (...args: unknown[]): void => {
            rec("bufferSubData", ...args);
        },
        createVertexArray: (): object => {
            rec("createVertexArray");
            return handle("vao");
        },
        bindVertexArray: (v: object | null): void => {
            rec("bindVertexArray", v);
        },
        deleteVertexArray: (v: object): void => {
            rec("deleteVertexArray", v);
        },
        enableVertexAttribArray: (i: number): void => {
            rec("enableVertexAttribArray", i);
        },
        vertexAttribPointer: (...args: unknown[]): void => {
            rec("vertexAttribPointer", ...args);
        },
        // ──── viewport / draw ──────────────────────────────────────────
        viewport: (x: number, y: number, w: number, h: number): void => {
            rec("viewport", x, y, w, h);
        },
        // ──── blend state (setBlendMode) ───────────────────────────────
        enable: (cap: number): void => {
            rec("enable", cap);
        },
        disable: (cap: number): void => {
            rec("disable", cap);
        },
        blendFuncSeparate: (srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): void => {
            rec("blendFuncSeparate", srcRGB, dstRGB, srcAlpha, dstAlpha);
        },
        blendEquationSeparate: (modeRGB: number, modeAlpha: number): void => {
            rec("blendEquationSeparate", modeRGB, modeAlpha);
        },
        drawElements: (...args: unknown[]): void => {
            rec("drawElements", ...args);
        },
        drawElementsInstanced: (...args: unknown[]): void => {
            rec("drawElementsInstanced", ...args);
        },
        vertexAttribDivisor: (index: number, divisor: number): void => {
            rec("vertexAttribDivisor", index, divisor);
        },
        disableVertexAttribArray: (i: number): void => {
            rec("disableVertexAttribArray", i);
        },
        uniformMatrix3fv: (loc: object, transpose: boolean, value: unknown): void => {
            rec("uniformMatrix3fv", loc, transpose, value);
        },
        uniform1fv: (loc: object, value: unknown): void => {
            rec("uniform1fv", loc, value);
        },
        uniform4fv: (loc: object, value: unknown): void => {
            rec("uniform4fv", loc, value);
        },
        uniform1iv: (loc: object, value: unknown): void => {
            rec("uniform1iv", loc, value);
        },
        // ──── framebuffers / renderbuffers (render targets) ──────────────
        createFramebuffer: (): object => {
            rec("createFramebuffer");
            return handle("framebuffer");
        },
        deleteFramebuffer: (f: object | null): void => {
            rec("deleteFramebuffer", f);
        },
        bindFramebuffer: (target: number, f: object | null): void => {
            rec("bindFramebuffer", target, f);
        },
        framebufferTexture2D: (...args: unknown[]): void => {
            rec("framebufferTexture2D", ...args);
        },
        framebufferRenderbuffer: (...args: unknown[]): void => {
            rec("framebufferRenderbuffer", ...args);
        },
        checkFramebufferStatus: (target: number): number => {
            rec("checkFramebufferStatus", target);
            return 0x8cd5; // FRAMEBUFFER_COMPLETE
        },
        createRenderbuffer: (): object => {
            rec("createRenderbuffer");
            return handle("renderbuffer");
        },
        deleteRenderbuffer: (r: object | null): void => {
            rec("deleteRenderbuffer", r);
        },
        bindRenderbuffer: (target: number, r: object | null): void => {
            rec("bindRenderbuffer", target, r);
        },
        renderbufferStorage: (...args: unknown[]): void => {
            rec("renderbufferStorage", ...args);
        },
        readPixels: (...args: unknown[]): void => {
            rec("readPixels", ...args);
        },
        // ──── depth / stencil / cull / scissor / clear ───────────────────
        depthFunc: (f: number): void => {
            rec("depthFunc", f);
        },
        depthMask: (m: boolean): void => {
            rec("depthMask", m);
        },
        colorMask: (r: boolean, g: boolean, b: boolean, a: boolean): void => {
            rec("colorMask", r, g, b, a);
        },
        cullFace: (f: number): void => {
            rec("cullFace", f);
        },
        stencilFunc: (func: number, ref: number, mask: number): void => {
            rec("stencilFunc", func, ref, mask);
        },
        stencilOp: (fail: number, zfail: number, zpass: number): void => {
            rec("stencilOp", fail, zfail, zpass);
        },
        stencilMask: (m: number): void => {
            rec("stencilMask", m);
        },
        scissor: (x: number, y: number, w: number, h: number): void => {
            rec("scissor", x, y, w, h);
        },
        clearColor: (r: number, g: number, b: number, a: number): void => {
            rec("clearColor", r, g, b, a);
        },
        clearDepth: (d: number): void => {
            rec("clearDepth", d);
        },
        clear: (mask: number): void => {
            rec("clear", mask);
        },
    } as unknown as WebGL2RenderingContext;

    return {
        gl,
        log,
        programs,
        count: (name) => log.reduce((acc, c) => acc + (c.name === name ? 1 : 0), 0),
        clear: () => {
            log.length = 0;
        },
        setCompileSuccess: (ok) => {
            state.compileSuccess = ok;
        },
        setLinkSuccess: (ok) => {
            state.linkSuccess = ok;
        },
        setParallelComplete: (ok) => {
            state.parallelComplete = ok;
        },
        setParallelAvailable: (ok) => {
            state.parallelAvailable = ok;
        },
        setExtensionAvailable: (name, ok) => {
            state.extensions[name] = ok;
        },
    };
}

/** A canvas stub good enough for createGLEngine + DOM event hooks. */
export function createMockCanvas(mock: MockGL): MockCanvas {
    const listeners: { type: string; cb: EventListener }[] = [];
    const c = {
        __glOverride: mock.gl,
        __listeners: listeners,
        width: 1,
        height: 1,
        clientWidth: 1,
        clientHeight: 1,
        getContext(_kind: string, _attrs: unknown) {
            return this.__glOverride;
        },
        addEventListener(type: string, cb: EventListener) {
            listeners.push({ type, cb });
        },
        removeEventListener(type: string, cb: EventListener) {
            const i = listeners.findIndex((l) => l.type === type && l.cb === cb);
            if (i !== -1) {
                listeners.splice(i, 1);
            }
        },
        dispatchEvent(_e: Event) {
            return true;
        },
    };
    return c as unknown as MockCanvas;
}

/** Fire a `webglcontextlost` event with `preventDefault` recorded. */
export function fireLost(canvas: MockCanvas): void {
    const listener = canvas.__listeners.find((l) => l.type === "webglcontextlost");
    if (listener === undefined) {
        return;
    }
    const e = { preventDefault: () => undefined, type: "webglcontextlost" } as unknown as Event;
    listener.cb(e);
}

export function fireRestored(canvas: MockCanvas): void {
    const listener = canvas.__listeners.find((l) => l.type === "webglcontextrestored");
    if (listener === undefined) {
        return;
    }
    const e = { type: "webglcontextrestored" } as unknown as Event;
    listener.cb(e);
}
