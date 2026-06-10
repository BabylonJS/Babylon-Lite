/**
 * Define the WebGPU flag-namespace globals in the Node test environment.
 *
 * In a browser these globals exist before any module loads, so modules may
 * capture them at import time (e.g. `engine/gpu-flags.ts` aliases them to short
 * names to cut bundle size). Node has no WebGPU, and individual test files that
 * installed these globals did so at test-file top level — which, due to ESM
 * import hoisting, runs *after* the modules under test are imported. Installing
 * them here (a vitest setup file, evaluated before the test module and its
 * imports) matches the browser ordering. Values are the real WebGPU bitflags,
 * so the per-file `??=` mocks remain compatible no-ops.
 */
const g = globalThis as Record<string, unknown>;

g.GPUBufferUsage ??= {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
};

g.GPUTextureUsage ??= {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
};

g.GPUShaderStage ??= {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
};

g.GPUColorWrite ??= {
    RED: 0x1,
    GREEN: 0x2,
    BLUE: 0x4,
    ALPHA: 0x8,
    ALL: 0xf,
};
