import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Scene } from "@babylonjs/core/scene";

// Same scene as the Lite side, built on core's StorageBuffer created with the VERTEX flag,
// so one allocation is both a storage buffer and the vertex source every chunk draws from.
// The vertices are built on the CPU on both sides, so the two engines are compared on the
// binding and draw path rather than on how the bytes were produced.
const GRID = 24;
const VERTS_PER_CHUNK = GRID * GRID;
const CHUNKS = 4;
const VERTS_TOTAL = VERTS_PER_CHUNK * CHUNKS;
const CHUNK_SIZE = 2.0;
const STRIDE = 16;

const CHUNK_ORIGINS: readonly [number, number][] = [
    [-CHUNK_SIZE, -CHUNK_SIZE],
    [0, -CHUNK_SIZE],
    [-CHUNK_SIZE, 0],
    [0, 0],
];


ShaderStore.ShadersStoreWGSL["scene285VertexShader"] = `
#include<sceneUboDeclaration>
#include<meshUboDeclaration>

attribute position : vec4<f32>;
varying shade : f32;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
    vertexOutputs.position = scene.viewProjection * mesh.world * vec4<f32>(vertexInputs.position.xyz, 1.0);
    vertexOutputs.shade = vertexInputs.position.w;
}`;

ShaderStore.ShadersStoreWGSL["scene285FragmentShader"] = `
varying shade : f32;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
    let t = clamp(fragmentInputs.shade * 0.9 + 0.5, 0.0, 1.0);
    fragmentOutputs.color = vec4<f32>(0.10 + t * 0.35, 0.35 + t * 0.50, 0.55 + t * 0.40, 1.0);
}`;

/** Every vertex of every chunk, packed back to back so chunk `c` occupies the run starting
 *  at `c * VERTS_PER_CHUNK` — the same layout the Lite side builds. */
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

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(51 / 255, 51 / 255, 76 / 255, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3.1, 7.5, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    // Storage allocation that is also a vertex source, seeded from the CPU.
    const slab = new StorageBuffer(engine, VERTS_TOTAL * STRIDE, Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_VERTEX | Constants.BUFFER_CREATIONFLAG_WRITE, "terrain-slab");
    slab.update(buildSlab());

    const material = new ShaderMaterial(
        "scene285Shader",
        scene,
        { vertex: "scene285", fragment: "scene285" },
        { attributes: ["position"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
    );

    const indices = buildChunkIndices();

    for (let i = 0; i < CHUNKS; i++) {
        const mesh = new Mesh(`chunk${i}`, scene);
        const geometry = new Geometry(`chunk${i}-geo`, scene);
        // Every chunk reads the ONE slab; its slot is addressed by the vertex buffer's byte
        // offset, which is core's equivalent of Lite's `baseVertex`.
        const vb = new VertexBuffer(engine, slab.getBuffer(), VertexBuffer.PositionKind, {
            size: 4,
            stride: STRIDE,
            offset: i * VERTS_PER_CHUNK * STRIDE,
            type: VertexBuffer.FLOAT,
            useBytes: true,
            updatable: false,
        });
        geometry.setVerticesBuffer(vb, VERTS_PER_CHUNK);
        geometry.setIndices(indices, VERTS_PER_CHUNK);
        geometry.applyToMesh(mesh);
        mesh.material = material;
        mesh.isUnIndexed = false;
        // The CPU never sees these vertices, so the box is stated analytically.
        const [ox, oz] = CHUNK_ORIGINS[i]!;
        mesh.buildBoundingInfo(new Vector3(ox, -0.42, oz), new Vector3(ox + CHUNK_SIZE, 0.42, oz + CHUNK_SIZE));
    }

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
