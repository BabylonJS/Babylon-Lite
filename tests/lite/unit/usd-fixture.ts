import { vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { UsdAssetContainer, UsdExtraction } from "../../../packages/babylon-lite/src/loader-usd/usd-types";

export function usdTestEngine() {
    const buffers: GPUBuffer[] = [];
    const textures: GPUTexture[] = [];
    const engine = {
        _device: {
            createBuffer: vi.fn((options: GPUBufferDescriptor) => {
                const bytes = new ArrayBuffer(Number(options.size));
                const buffer = { getMappedRange: () => bytes, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
                buffers.push(buffer);
                return buffer;
            }),
            createTexture: vi.fn(() => {
                const texture = { destroy: vi.fn(), createView: vi.fn(() => ({})), width: 1, height: 1, mipLevelCount: 1 } as unknown as GPUTexture;
                textures.push(texture);
                return texture;
            }),
            createSampler: vi.fn(() => ({})),
            createCommandEncoder: vi.fn(() => ({ finish: vi.fn(() => ({})) })),
            queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), copyExternalImageToTexture: vi.fn(), submit: vi.fn() },
        },
    } as unknown as EngineContext;
    return { engine, buffers, textures };
}

export function usdTestContainer(extraction: UsdExtraction): UsdAssetContainer {
    return {
        entities: [],
        _usdMeshes: [],
        _usdTextures: [],
        diagnostics: {
            timings: { ...extraction.timings, materializeMs: 0 },
            statistics: extraction.statistics,
            missingAssets: [],
        },
    };
}

export function usdFixture(
    options: {
        textures?: boolean;
        skin?: boolean;
        morph?: boolean;
        duplicateMorph?: boolean;
        thinInstances?: boolean;
        analytic?: number;
        zUp?: boolean;
        scale?: number;
        leftHanded?: boolean;
        zeroFps?: boolean;
        trsAnimation?: boolean;
    } = {}
): UsdExtraction {
    const raw: number[] = [];
    const records: Array<{ op: number; fields: Array<number | { f: number }> }> = [];
    const append = (bytes: Uint8Array) => {
        while (raw.length % 4) {
            raw.push(0);
        }
        const offset = raw.length;
        raw.push(...bytes);
        return offset;
    };
    const floats = (v: number[]) => append(new Uint8Array(new Float32Array(v).buffer));
    const uints = (v: number[]) => append(new Uint8Array(new Uint32Array(v).buffer));
    const uint16 = (v: number[]) => append(new Uint8Array(new Uint16Array(v).buffer));
    const name = append(new TextEncoder().encode("Fixture"));
    const none = 0xffffffff;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const matrix = floats(identity);
    const shifted = [...identity];
    shifted[12] = 3;
    const shiftedMatrix = floats(shifted);
    const f = (value: number) => ({ f: value });
    records.push({ op: 1, fields: [options.zUp ? 1 : 0, f(options.scale ?? 1), f(options.zeroFps ? 0 : 24)] });
    records.push({ op: 4, fields: [1, none, name, 7, matrix] }, { op: 4, fields: [2, none, name, 7, shiftedMatrix] });
    if (options.textures) {
        const image = append(Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")));
        const length = raw.length - image;
        const tx = floats([2, 3, 0.1, 0.2, Math.PI / 4]);
        const identityValue = floats([1, 1, 1, 1, 0, 0, 0, 0]);
        const scalarValue = floats([0.2, 0.3, 0.4, 1, 0.1, 0.2, 0.3, 0]);
        const normalValue = floats([2, 2, 2, 1, -1, -1, -1, 0]);
        records.push(
            { op: 2, fields: [1, name, 7, 1, image, length, 0, tx, 1, 2, 2, identityValue] },
            { op: 2, fields: [2, name, 7, 1, image, length, 0, tx, 1, 2, 1, normalValue] },
            { op: 2, fields: [3, name, 7, 1, image, length, 0, tx, 1, 2, 1, scalarValue] }
        );
    }
    const color = floats([0.2, 0.6, 0.9, 0.8]);
    const emissive = floats([0.1, 0.2, 0.3]);
    for (let id = 1; id <= 2; id++) {
        records.push({
            op: 3,
            fields: [
                id,
                name,
                7,
                color,
                emissive,
                f(0.4),
                f(0.6),
                f(0.7),
                f(id === 2 ? 0.5 : 0),
                id === 1 ? 4 : 5,
                options.textures ? 1 : none,
                none,
                options.textures ? 2 : none,
                options.textures ? 3 : none,
                options.textures ? 3 : none,
                options.textures ? 3 : none,
                none,
                options.textures ? 4 : none,
                none,
                options.textures ? 4 : none,
                options.textures ? 2 : none,
                options.textures ? 1 : none,
                options.textures ? 0 : none,
                none,
            ],
        });
    }
    const restChild = [...identity];
    restChild[13] = 1;
    const restChildOffset = floats(restChild);
    if (options.skin) {
        const bindChild = [...identity];
        bindChild[13] = 2;
        const bindChildOffset = floats(bindChild);
        const joints = uints([none, 10, name, 7, matrix, matrix, 0, 11, name, 7, restChildOffset, bindChildOffset]);
        records.push({ op: 5, fields: [1, name, 7, 2, joints] });
    }
    const positions = floats([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const normals = floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uv = floats([0, 0, 1, 0, 1, 1, 0, 1]);
    const joints0 = uint16(Array(4).fill([0, 1, 0, 1]).flat());
    const weights0 = floats(Array(4).fill([0.5, 0.1, 0.1, 0.1]).flat());
    const joints1 = uint16(Array(4).fill([1, 0, 1, 0]).flat());
    const weights1 = floats(Array(4).fill([0.05, 0.05, 0.05, 0.05]).flat());
    const indices = uints([0, 1, 2, 0, 2, 3]);
    const subsets = uints([1, 0, 3, 0, 4, 2, 3, 3, 0, 4]);
    records.push({ op: 6, fields: [1, 4, 6, options.skin ? 53 : 5, positions, normals, none, uv, none, joints0, weights0, joints1, weights1, indices, 8] });
    if (options.analytic !== undefined) {
        records.push({ op: 10, fields: [1, 1, options.analytic, 1, name, 7, options.leftHanded ? 2 : 0, 2, f(1), f(2), 12] });
    } else {
        records.push({ op: 7, fields: [1, 1, 1, none, name, 7, options.leftHanded ? 2 : 0, options.skin ? 1 : none, subsets, 2] });
    }
    let morphId = 0;
    if (options.morph && options.analytic === undefined) {
        morphId = 1;
        const targetPositions = floats([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]);
        const targetNormals = floats([0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0]);
        const morphRecord = { op: 12, fields: [morphId, 1, name, 7, 4, targetPositions, targetNormals, f(0.25)] };
        records.push(morphRecord);
        if (options.duplicateMorph) {
            records.push(morphRecord);
        }
    }
    if (options.thinInstances) {
        const transforms = floats([...identity, ...shifted]);
        records.push({ op: 11, fields: [1, transforms, 2] });
    } else {
        records.push({ op: 8, fields: [1, 2, name, 7] });
    }
    if (options.skin) {
        const times = floats([0, 24]);
        const moved = [...identity];
        moved[12] = 2;
        const values = floats([...identity, ...moved]);
        const movedBone = [...restChild];
        movedBone[13] = 3;
        const boneValues = floats([...restChild, ...movedBone]);
        records.push({ op: 9, fields: [0, 1, 3, 0, 2, times, values, 16] }, { op: 9, fields: [1, 11, 3, 0, 2, times, boneValues, 16] });
    }
    if (options.trsAnimation) {
        const times = floats([0, 24]);
        const translations = floats([0, 0, 0, 2, 0, 0]);
        records.push({ op: 9, fields: [0, 1, 0, 0, 2, times, translations, 3] });
    }
    if (morphId) {
        const times = floats([0, 24]);
        const influences = floats([0.25, 0.75]);
        records.push({ op: 9, fields: [2, morphId, 4, 0, 2, times, influences, 1] });
    }
    const buffer = new ArrayBuffer(16 + records.reduce((sum, r) => sum + 8 + r.fields.length * 4, 0));
    const view = new DataView(buffer);
    view.setUint32(0, 0x42445355, true);
    view.setUint16(4, 5, true);
    view.setUint32(8, records.length, true);
    let cursor = 16;
    for (const { op, fields } of records) {
        view.setUint16(cursor, op, true);
        view.setUint32(cursor + 4, fields.length * 4, true);
        cursor += 8;
        for (const value of fields) {
            if (typeof value === "number") {
                view.setUint32(cursor, value, true);
            } else {
                view.setFloat32(cursor, value.f, true);
            }
            cursor += 4;
        }
    }
    return {
        commands: buffer,
        data: Uint8Array.from(raw).buffer,
        timings: { totalMs: 1, stageOpenMs: 1, stageReadMs: 0, preparationMs: 0, packingMs: 0, heapCopyMs: 0 },
        statistics: { nodes: 2, meshes: 1, analyticPrimitives: 0, instances: 1, materials: 2, vertices: 4, triangles: 2, commandBytes: buffer.byteLength, dataBytes: raw.length },
        missingAssets: [],
    };
}
