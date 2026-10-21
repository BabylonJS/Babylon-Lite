/** Test harness for the glTF exporter: a fake WebGPU device that supports the exporter's readback
 *  paths, fabricated plain-data scenes, and a GLB parser. No real GPU is needed. */

import { vi } from "vitest";
import { exportSceneAsGlb } from "../../../../packages/babylon-lite/src/export-gltf/export-gltf";
import { initMeshTransform } from "../../../../packages/babylon-lite/src/mesh/mesh";
import type { Mesh, MeshGPU } from "../../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d";

/** A fake GPUTexture carrying its mip-0 pixels (tight RGBA8, or one float per channel for float formats). */
export interface FakeGpuTexture {
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: number;
    dimension: GPUTextureDimension;
    depthOrArrayLayers: number;
    sampleCount?: number;
    /** Storage-order bytes as the GPU holds them (BGRA order for bgra formats). */
    __pixels: Uint8Array;
    destroyed?: boolean;
    destroy(): void;
    createView(): { __texture: FakeGpuTexture };
}

/** Counters the tests can assert on. */
export interface FakeDeviceStats {
    copies: number;
    blits: number;
    buffersCreated: number;
    buffersDestroyed: number;
    texturesCreated: number;
    texturesDestroyed: number;
}

/** A fake GPUDevice implementing exactly what the exporter's readback uses: command encoders with
 *  `copyTextureToBuffer` and a one-draw blit render pass, staging buffers with `mapAsync`, transient
 *  textures, shader modules, layouts and pipelines. `failMap` makes every `mapAsync` reject,
 *  `failCreateBuffer` makes `createBuffer` throw synchronously and `maxBufferSize` sets `limits.maxBufferSize`. */
export function createFakeDevice(options: { failMap?: boolean; maxBufferSize?: number; failCreateBuffer?: boolean } = {}): { device: GPUDevice; stats: FakeDeviceStats } {
    const stats: FakeDeviceStats = { copies: 0, blits: 0, buffersCreated: 0, buffersDestroyed: 0, texturesCreated: 0, texturesDestroyed: 0 };
    const device = {
        ...(options.maxBufferSize !== undefined ? { limits: { maxBufferSize: options.maxBufferSize } } : {}),
        createCommandEncoder() {
            return {
                copyTextureToBuffer(src: { texture: FakeGpuTexture }, dst: { buffer: { __data: Uint8Array }; bytesPerRow: number }, size: { width: number; height: number }) {
                    stats.copies++;
                    const rowBytes = size.width * 4;
                    for (let y = 0; y < size.height; y++) {
                        dst.buffer.__data.set(src.texture.__pixels.subarray(y * rowBytes, y * rowBytes + rowBytes), y * dst.bytesPerRow);
                    }
                },
                beginRenderPass(desc: { colorAttachments: { view: { __texture: FakeGpuTexture } }[] }) {
                    const target = desc.colorAttachments[0]!.view.__texture;
                    let source: FakeGpuTexture | null = null;
                    return {
                        setPipeline() {},
                        setBindGroup(_i: number, group: { __source: FakeGpuTexture }) {
                            source = group.__source;
                        },
                        draw() {
                            stats.blits++;
                            // The blit copies texels verbatim (clamped); fake float sources store bytes already.
                            target.__pixels.set(source!.__pixels.subarray(0, target.__pixels.length));
                        },
                        end() {},
                    };
                },
                finish() {
                    return {};
                },
            };
        },
        createBuffer(desc: { size: number }) {
            if (options.failCreateBuffer) {
                throw new Error("createBuffer failed");
            }
            stats.buffersCreated++;
            const data = new Uint8Array(desc.size);
            return {
                __data: data,
                mapAsync: () => (options.failMap ? Promise.reject(new Error("device lost")) : Promise.resolve()),
                getMappedRange: () => data.buffer,
                unmap() {},
                destroy() {
                    stats.buffersDestroyed++;
                },
            };
        },
        createTexture(desc: { size: { width: number; height: number }; format: GPUTextureFormat; usage: number }) {
            stats.texturesCreated++;
            const t = fakeGpuTexture(desc.size.width, desc.size.height, desc.format, desc.usage, new Uint8Array(desc.size.width * desc.size.height * 4));
            const destroy = t.destroy;
            t.destroy = () => {
                stats.texturesDestroyed++;
                destroy();
            };
            return t;
        },
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({}),
        createBindGroup(desc: { entries: { resource: { __texture: FakeGpuTexture } }[] }) {
            return { __source: desc.entries[0]!.resource.__texture };
        },
        queue: { submit() {} },
    };
    return { device: device as unknown as GPUDevice, stats };
}

function fakeGpuTexture(width: number, height: number, format: GPUTextureFormat, usage: number, pixels: Uint8Array): FakeGpuTexture {
    const t: FakeGpuTexture = {
        width,
        height,
        format,
        usage,
        dimension: "2d",
        depthOrArrayLayers: 1,
        __pixels: pixels,
        destroy() {
            t.destroyed = true;
        },
        createView() {
            return { __texture: t };
        },
    };
    return t;
}

/** Options for {@link createTexture}. */
export interface FakeTextureOptions {
    format?: GPUTextureFormat;
    /** GPUTextureUsage bits; defaults to COPY_SRC | TEXTURE_BINDING (a glTF-loader raster image). */
    usage?: number;
    invertY?: boolean;
    /** Texture2D wrapper extras: uScale/vScale/uOffset/vOffset/uAng, `_hasTx`, `_texCoord`. */
    wrapper?: Record<string, unknown>;
    dimension?: GPUTextureDimension;
    layers?: number;
    sampleCount?: number;
}

/** A Texture2D over a fake GPU texture. `pixels` (RGBA bytes, row 0 first in storage order) is
 *  repeated to fill `width × height` texels. */
export function createTexture(width: number, height: number, pixels: readonly number[], options: FakeTextureOptions = {}): Texture2D {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) {
        data[i] = pixels[i % pixels.length]!;
    }
    const gpu = fakeGpuTexture(width, height, options.format ?? "rgba8unorm", options.usage ?? GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING, data);
    gpu.dimension = options.dimension ?? "2d";
    gpu.depthOrArrayLayers = options.layers ?? 1;
    if (options.sampleCount !== undefined) {
        gpu.sampleCount = options.sampleCount;
    }
    return {
        texture: gpu as unknown as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width,
        height,
        ...(options.invertY !== undefined ? { invertY: options.invertY } : {}),
        ...options.wrapper,
    } as Texture2D;
}

/** Geometry for {@link createMesh}. Arrays default to a unit quad in the XY plane facing −Z. */
export interface FakeMeshOptions {
    positions?: Float32Array;
    normals?: Float32Array | null;
    uvs?: Float32Array | null;
    uv2s?: Float32Array | null;
    tangents?: Float32Array | null;
    colors?: Float32Array | null;
    indices?: Uint32Array | null;
    gpuIndices?: Uint16Array | Uint32Array;
    /** GPU-only attributes: present on `_gpu` without a CPU array. */
    gpuOnly?: ("tangent" | "uv2" | "color")[];
    authoredSign?: number;
    material?: Mesh["material"];
    extra?: Record<string, unknown>;
}

export const QUAD_POSITIONS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
export const QUAD_NORMALS = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
export const QUAD_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
export const QUAD_INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);

/** A plain-data Lite mesh with CPU geometry and a fake `_gpu` (no GPU allocation). Each call
 *  creates fresh arrays unless the caller passes shared ones. */
export function createMesh(name: string, options: FakeMeshOptions = {}): Mesh {
    const gpu: Record<string, unknown> = {};
    for (const kind of options.gpuOnly ?? []) {
        gpu[`${kind}Buffer`] = {};
    }
    if (options.uv2s) {
        gpu.uv2Buffer = {};
    }
    const mesh = initMeshTransform({
        name,
        material: options.material ?? (null as unknown as Mesh["material"]),
        receiveShadows: false,
        _gpu: gpu as unknown as MeshGPU,
        _cpuPositions: options.positions ?? QUAD_POSITIONS.slice(),
        _cpuNormals: options.normals === null ? undefined : (options.normals ?? QUAD_NORMALS.slice()),
        _cpuUvs: options.uvs === null ? undefined : (options.uvs ?? QUAD_UVS.slice()),
        _cpuUv2s: options.uv2s ?? null,
        _cpuTangents: options.tangents ?? null,
        _cpuColors: options.colors ?? null,
        _cpuIndices: options.indices === null ? undefined : (options.indices ?? QUAD_INDICES.slice()),
        ...(options.gpuIndices ? { _cpuGpuIndices: options.gpuIndices } : {}),
        ...(options.authoredSign !== undefined ? { _authoredSign: options.authoredSign } : {}),
        ...options.extra,
    });
    return mesh;
}

/** Parent `child` under `parent` the way `addToScene` leaves glTF hierarchies: `parent` set and the
 *  child listed in `parent.children`. */
export function attach<T extends { parent: unknown }>(child: T, parent: { children: unknown[] }): T {
    child.parent = parent as T["parent"];
    parent.children.push(child);
    return child;
}

/** Options for {@link createScene}. */
export interface FakeSceneOptions {
    meshes?: Mesh[];
    lights?: SceneContext["lights"];
    camera?: SceneContext["camera"];
    animationGroups?: SceneContext["animationGroups"];
    /** A fake device for texture readback; omit for a null engine (no `_device`). */
    device?: GPUDevice;
    /** Canvas size for the camera aspect ratio; omit for no canvas. */
    canvas?: { width: number; height: number };
}

/** A plain-object SceneContext exposing only what the exporter reads. */
export function createScene(options: FakeSceneOptions = {}): SceneContext {
    return {
        surface: { engine: options.device ? { _device: options.device } : {}, ...(options.canvas ? { canvas: options.canvas } : {}) },
        meshes: options.meshes ?? [],
        lights: options.lights ?? [],
        camera: options.camera ?? null,
        animationGroups: options.animationGroups ?? [],
    } as unknown as SceneContext;
}

/** A parsed GLB. */
export interface ParsedGlb {
    json: any;
    bin: Uint8Array;
    bytes: Uint8Array;
    /** Messages passed to console.warn during the export (prefix stripped). */
    warnings: string[];
}

const WARN_PREFIX = "[babylon-lite] glTF export: ";

/** Export a scene and parse the resulting GLB, capturing warnings. */
export async function exportAndParse(scene: SceneContext): Promise<ParsedGlb> {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        const text = String(args[0]);
        warnings.push(text.startsWith(WARN_PREFIX) ? text.slice(WARN_PREFIX.length) : text);
    });
    try {
        const blob = await exportSceneAsGlb(scene);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { ...parseGlb(bytes), bytes, warnings };
    } finally {
        spy.mockRestore();
    }
}

/** Split a GLB into its JSON document and BIN payload, checking the framing. */
export function parseGlb(bytes: Uint8Array): { json: ParsedGlb["json"]; bin: Uint8Array } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
        throw new Error("bad GLB header");
    }
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a) {
        throw new Error("bad JSON chunk");
    }
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    const binHeader = 20 + jsonLength;
    const binLength = view.getUint32(binHeader, true);
    if (view.getUint32(binHeader + 4, true) !== 0x004e4942) {
        throw new Error("bad BIN chunk");
    }
    return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Read an accessor's elements as plain numbers. */
export function readAccessor(glb: { json: ParsedGlb["json"]; bin: Uint8Array }, index: number): number[] {
    const accessor = glb.json.accessors[index];
    const view = glb.json.bufferViews[accessor.bufferView];
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const n = accessor.count * COMPONENTS[accessor.type]!;
    const buffer = glb.bin.buffer.slice(glb.bin.byteOffset + offset, glb.bin.byteOffset + offset + n * 4);
    switch (accessor.componentType) {
        case 5126:
            return Array.from(new Float32Array(buffer, 0, n));
        case 5125:
            return Array.from(new Uint32Array(buffer, 0, n));
        case 5123:
            return Array.from(new Uint16Array(glb.bin.buffer.slice(glb.bin.byteOffset + offset, glb.bin.byteOffset + offset + n * 2)));
        case 5121:
            return Array.from(glb.bin.subarray(offset, offset + n));
        default:
            throw new Error(`unsupported componentType ${accessor.componentType}`);
    }
}

/** The bytes of a bufferView. */
export function readBufferView(glb: { json: ParsedGlb["json"]; bin: Uint8Array }, index: number): Uint8Array {
    const view = glb.json.bufferViews[index];
    return glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

/** Decode an exported PNG image back to RGBA bytes (filter 0 only, as the exporter writes). */
export async function decodePng(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    let offset = 8;
    const idat: Uint8Array[] = [];
    while (offset < png.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
        if (type === "IDAT") {
            idat.push(png.subarray(offset + 8, offset + 8 + length));
        }
        offset += 12 + length;
    }
    const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of idat) {
        compressed.set(c, o);
        o += c.length;
    }
    const raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
    }
    return { width, height, rgba };
}
