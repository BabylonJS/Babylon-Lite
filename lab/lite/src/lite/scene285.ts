import {
    addToScene,
    createArcRotateCamera,
    createComputeShader,
    createEngine,
    createMeshFromStorageBuffer,
    createSceneContext,
    createShaderMaterial,
    createStorageBuffer,
    dispatchCompute,
    prepareComputeShader,
    registerScene,
    setComputeStorageBuffer,
    setComputeUniform,
    setShaderAttributeFormats,
    startEngine,
} from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";

// Four terrain chunks generated entirely on the GPU into ONE storage allocation, each
// drawn from its own slot in that slab. No readback, no copy: the compute pass writes
// the vertices and the draw reads them in place.
const GRID = 24; // vertices per side of a chunk
const VERTS_PER_CHUNK = GRID * GRID;
const CHUNKS = 4;
const VERTS_TOTAL = VERTS_PER_CHUNK * CHUNKS;
const CHUNK_SIZE = 2.0;
const STRIDE = 16; // one float32x4 per vertex: xyz position, w a packed height ramp

// Chunk origins, laid out 2x2 around the origin.
const CHUNK_ORIGINS: readonly [number, number][] = [
    [-CHUNK_SIZE, -CHUNK_SIZE],
    [0, -CHUNK_SIZE],
    [-CHUNK_SIZE, 0],
    [0, 0],
];

const computeSource = `
struct ChunkParams { ox: f32, oz: f32, tint: f32, pad: f32 };

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= uniforms.vertsTotal) { return; }

    let chunk = i / uniforms.vertsPerChunk;
    let v = i % uniforms.vertsPerChunk;
    let gx = v % uniforms.gridDim;
    let gz = v / uniforms.gridDim;

    let p = params[chunk];
    let fx = f32(gx) / f32(uniforms.gridDim - 1u);
    let fz = f32(gz) / f32(uniforms.gridDim - 1u);
    let x = p.ox + fx * uniforms.chunkSize;
    let z = p.oz + fz * uniforms.chunkSize;
    let h = sin(x * 1.7) * cos(z * 1.7) * 0.42;

    // .w carries a per-vertex value the draw reads back out — the reason position is
    // declared float32x4 rather than the canonical float32x3.
    slab[i] = vec4<f32>(x, h, z, h + p.tint);
}`;

const vertexSource = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) shade:f32,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position.xyz,1.0);
    out.shade=input.position.w;
    return out;
}`;

const fragmentSource = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) shade:f32,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
    let t=clamp(input.shade*0.9+0.5,0.0,1.0);
    return vec4<f32>(0.10+t*0.35,0.35+t*0.50,0.55+t*0.40,1.0);
}`;

/** Triangle topology for one chunk. Every slot in the slab is byte-identical, so a single
 *  allocation is shared by all four meshes rather than uploaded four times. */
function buildChunkIndices(): Uint32Array {
    const quads = (GRID - 1) * (GRID - 1);
    const indices = new Uint32Array(quads * 6);
    let n = 0;
    for (let z = 0; z < GRID - 1; z++) {
        for (let x = 0; x < GRID - 1; x++) {
            const a = z * GRID + x;
            const b = a + 1;
            const c = a + GRID;
            const d = c + 1;
            indices[n++] = a;
            indices[n++] = b;
            indices[n++] = c;
            indices[n++] = b;
            indices[n++] = d;
            indices[n++] = c;
        }
    }
    return indices;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3.1, 7.5, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    // One writable, vertex-capable slab holding every chunk's vertices.
    const slab = createStorageBuffer(engine, VERTS_TOTAL * STRIDE, { writable: true, vertex: true, label: "terrain-slab" });

    // Per-chunk parameters live in a read-only storage buffer the shader indexes by
    // invocation, so ONE dispatch covers all four chunks.
    const params = new Float32Array(CHUNKS * 4);
    for (let i = 0; i < CHUNKS; i++) {
        params[i * 4 + 0] = CHUNK_ORIGINS[i]![0];
        params[i * 4 + 1] = CHUNK_ORIGINS[i]![1];
        params[i * 4 + 2] = i * 0.18 - 0.27;
    }
    const paramsBuffer = createStorageBuffer(engine, params, { label: "chunk-params" });

    const filler = createComputeShader(engine, {
        name: "terrain-fill",
        computeSource,
        uniforms: [
            { name: "vertsTotal", type: "u32" },
            { name: "vertsPerChunk", type: "u32" },
            { name: "gridDim", type: "u32" },
            { name: "chunkSize", type: "f32" },
        ],
        storageBuffers: [
            { name: "params", type: "array<ChunkParams>" },
            { name: "slab", type: "array<vec4<f32>>", writable: true },
        ],
    });
    setComputeUniform(filler, "vertsTotal", VERTS_TOTAL);
    setComputeUniform(filler, "vertsPerChunk", VERTS_PER_CHUNK);
    setComputeUniform(filler, "gridDim", GRID);
    setComputeUniform(filler, "chunkSize", CHUNK_SIZE);
    setComputeStorageBuffer(filler, "params", paramsBuffer);
    setComputeStorageBuffer(filler, "slab", slab);

    // Compile off the critical path, then fill the slab.
    await prepareComputeShader(filler);
    dispatchCompute(engine, filler, Math.ceil(VERTS_TOTAL / 64));

    const material = createShaderMaterial({
        name: "scene285Shader",
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
    // The shader reads `input.position` as vec4 — its own signature. Where those bytes sit
    // comes from each mesh's packing, below.
    setShaderAttributeFormats(material, { position: "float32x4" });

    // One shared index allocation for all four slots.
    const indices = createStorageBuffer(engine, buildChunkIndices(), { index: true, label: "chunk-indices" });
    const indexCount = (GRID - 1) * (GRID - 1) * 6;

    for (let i = 0; i < CHUNKS; i++) {
        const [ox, oz] = CHUNK_ORIGINS[i]!;
        const mesh = createMeshFromStorageBuffer(engine, `chunk${i}`, {
            storage: slab,
            indices,
            indexFormat: "uint32",
            indexCount,
            vertexCount: VERTS_PER_CHUNK,
            arrayStride: STRIDE,
            baseVertex: i * VERTS_PER_CHUNK,
            // The CPU never sees these vertices, so bounds are stated analytically.
            boundMin: [ox, -0.42, oz],
            boundMax: [ox + CHUNK_SIZE, 0.42, oz + CHUNK_SIZE],
        });
        mesh.material = material;
        addToScene(scene, mesh);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
