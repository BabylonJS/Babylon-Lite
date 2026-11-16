import { loadGltf } from "babylon-lite";
import type { EngineContext } from "babylon-lite";
import { buildBeamData } from "../shared/scene231-skin.js";

/** Self-contained procedural glTF exercises the public skin/morph animation path. */
export async function createAoDeformationExamples(engine: EngineContext) {
    const beam = buildBeamData();
    // The shared Lite beam uses left-handed winding; glTF requires counter-clockwise triangles.
    for (let i = 0; i < beam.indices.length; i += 3) {
        const second = beam.indices[i + 1]!;
        beam.indices[i + 1] = beam.indices[i + 2]!;
        beam.indices[i + 2] = second;
    }
    const chunks: Uint8Array[] = [];
    const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
    const accessors: { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }[] = [];
    let length = 0;
    const attribute = (data: Float32Array | Uint16Array | Uint32Array, type: string, stride: number, componentType = 5126) => {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
        const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
        padded.set(bytes);
        chunks.push(padded);
        length += padded.length;
        accessors.push({ bufferView: bufferViews.length - 1, componentType, count: data.length / stride, type });
        return accessors.length - 1;
    };
    const position = attribute(beam.positions, "VEC3", 3);
    accessors[position]!.min = [-0.25, -1, -0.25];
    accessors[position]!.max = [0.25, 1, 0.25];
    const normal = attribute(beam.normals, "VEC3", 3),
        uv = attribute(beam.uvs, "VEC2", 2);
    const indices = attribute(beam.indices, "SCALAR", 1, 5125);
    const joints = attribute(beam.joints, "VEC4", 4, 5123),
        weights = attribute(beam.weights, "VEC4", 4);
    const deltas = new Float32Array(beam.positions.length),
        normalDeltas = new Float32Array(beam.normals.length);
    for (let i = 0; i < beam.vertexCount; i++) {
        const x = beam.positions[i * 3]!,
            t = (beam.positions[i * 3 + 1]! + 1) / 2;
        deltas[i * 3] = x * 1.2 * t;
        deltas[i * 3 + 1] = 0.25 * t;
        const nx = beam.normals[i * 3]! / (1 + 1.2 * t);
        const ny = (beam.normals[i * 3 + 1]! - 0.6 * x * nx) / 1.125;
        const nz = beam.normals[i * 3 + 2]!,
            scale = 1 / Math.hypot(nx, ny, nz);
        normalDeltas[i * 3] = nx * scale - beam.normals[i * 3]!;
        normalDeltas[i * 3 + 1] = ny * scale - beam.normals[i * 3 + 1]!;
        normalDeltas[i * 3 + 2] = nz * scale - beam.normals[i * 3 + 2]!;
    }
    const morphPosition = attribute(deltas, "VEC3", 3),
        morphNormal = attribute(normalDeltas, "VEC3", 3);
    accessors[morphPosition]!.min = [Math.fround(-0.3), 0, 0];
    accessors[morphPosition]!.max = [Math.fround(0.3), 0.25, 0];
    const times = attribute(new Float32Array([0, 0.6, 1.2, 1.8, 2.4]), "SCALAR", 1);
    accessors[times]!.min = [0];
    accessors[times]!.max = [2.4];
    const rotations = new Float32Array(20);
    for (const [i, angle] of [0, 0.6, 0, -0.6, 0].entries()) {
        rotations[i * 4 + 2] = Math.sin(angle / 2);
        rotations[i * 4 + 3] = Math.cos(angle / 2);
    }
    const rotate = attribute(rotations, "VEC4", 4);
    const morphWeights = attribute(new Float32Array([0, 1, 0, 1, 0]), "SCALAR", 1);
    const binary = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        binary.set(chunk, offset);
        offset += chunk.length;
    }
    let encoded = "";
    for (const byte of binary) {
        encoded += String.fromCharCode(byte);
    }
    const gltf = {
        asset: { version: "2.0" },
        buffers: [{ byteLength: length, uri: `data:application/octet-stream;base64,${btoa(encoded)}` }],
        bufferViews,
        accessors,
        materials: [
            { pbrMetallicRoughness: { baseColorFactor: [0.12, 0.55, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
            { pbrMetallicRoughness: { baseColorFactor: [0.55, 0.16, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
        ],
        meshes: [
            {
                name: "Skinned beam",
                primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv, JOINTS_0: joints, WEIGHTS_0: weights }, indices, material: 0 }],
            },
            {
                name: "Morphed beam",
                weights: [0],
                primitives: [
                    { attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material: 1, targets: [{ POSITION: morphPosition, NORMAL: morphNormal }] },
                ],
            },
        ],
        nodes: [
            { name: "Skinned beam", mesh: 0, skin: 0, translation: [-2.65, 1, 0.2], children: [2] },
            { name: "Morphed beam", mesh: 1, translation: [-0.3, 1, -1.7] },
            { name: "Root", children: [3] },
            { name: "Upper" },
        ],
        skins: [{ joints: [2, 3], skeleton: 2 }],
        animations: [
            {
                name: "Skin and morph motion",
                samplers: [
                    { input: times, output: rotate, interpolation: "LINEAR" },
                    { input: times, output: morphWeights, interpolation: "LINEAR" },
                ],
                channels: [
                    { sampler: 0, target: { node: 3, path: "rotation" } },
                    { sampler: 1, target: { node: 1, path: "weights" } },
                ],
            },
        ],
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
    };
    return loadGltf(engine, new Blob([JSON.stringify(gltf)], { type: "model/gltf+json" }));
}
