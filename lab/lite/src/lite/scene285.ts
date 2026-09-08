import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createMeshFromStorageBuffer,
    createSceneContext,
    createShaderMaterial,
    createStorageBuffer,
    registerScene,
    setShaderAttributeFormats,
    startEngine,
} from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";

// Four terrain chunks living in ONE storage allocation, each drawn from its own slot in
// that slab. This is the storage-buffer contract end to end: an allocation that is both a
// StorageBuffer and a vertex source, several meshes borrowing slots out of it addressed by
// a non-zero `baseVertex`, one shared index allocation behind all of them, and a
// `float32x4` position whose `.w` carries per-vertex data the shader reads back out.
//
// The vertices are built on the CPU. Producing them with a compute pass is the same
// storage contract from the other end, and that half is being designed separately -- what
// this scene has to pin is that the geometry BINDS and DRAWS correctly, which unit tests
// cannot check: they see neither the real WebGPU usage flags, nor the vertex layout the
// pipeline is built from, nor the indexed draw that reads the slot.
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

/** Every vertex of every chunk, packed back to back so chunk `c` occupies the run starting
 *  at `c * VERTS_PER_CHUNK` — which is exactly the `baseVertex` each mesh is given. */
function buildSlab(): Float32Array {
    const data = new Float32Array(VERTS_TOTAL * 4);
    let n = 0;
    for (let c = 0; c < CHUNKS; c++) {
        const [ox, oz] = CHUNK_ORIGINS[c]!;
        const tint = c * 0.18 - 0.27;
        for (let gz = 0; gz < GRID; gz++) {
            for (let gx = 0; gx < GRID; gx++) {
                const x = ox + (gx / (GRID - 1)) * CHUNK_SIZE;
                const z = oz + (gz / (GRID - 1)) * CHUNK_SIZE;
                const h = Math.sin(x * 1.7) * Math.cos(z * 1.7) * 0.42;
                data[n++] = x;
                data[n++] = h;
                data[n++] = z;
                data[n++] = h + tint;
            }
        }
    }
    return data;
}

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

    // One allocation, both a storage buffer and a vertex source, seeded from the CPU.
    const slab = createStorageBuffer(engine, buildSlab(), { vertex: true, label: "terrain-slab" });

    // One shared index allocation for all four slots.
    const indices = createStorageBuffer(engine, buildChunkIndices(), { index: true, label: "chunk-indices" });
    const indexCount = (GRID - 1) * (GRID - 1) * 6;

    const material = createShaderMaterial({ name: "terrain", vertexSource, fragmentSource, attributes: ["position"], uniforms: ["worldViewProjection"] });
    // The slab packs a per-vertex value into `position.w`, so the shader's position is a
    // float32x4 rather than the canonical float32x3. That is the material's signature, not
    // the geometry's packing, which is why it is declared here and not on the mesh.
    setShaderAttributeFormats(material, { position: "float32x4" });

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
            // The CPU never sees these vertices once uploaded, so bounds are stated analytically.
            boundMin: [ox, -0.42, oz],
            boundMax: [ox + CHUNK_SIZE, 0.42, oz + CHUNK_SIZE],
        });
        mesh.material = material as unknown as typeof mesh.material;
        addToScene(scene, mesh);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
