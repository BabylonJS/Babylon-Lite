// Scene 286: an interleaved glTF mesh drawn by a ShaderMaterial.
//
// Buffer_Interleaved_03.gltf packs POSITION (offset 0) and COLOR_0 (offset 12) into one
// bufferView at byteStride 28. The PBR, Standard and picking paths have always read that
// packing from `MeshGPU._vbLayout`; the ShaderMaterial path did not, so it fetched both
// attributes at their canonical tight strides and the quad collapsed to nothing.
//
// Reading COLOR_0 as well as POSITION is deliberate, but note what each attribute actually
// proves here: the loader always materializes COLOR_0 into its own tight float32x4 buffer
// (see `gltf-interleave.ts`'s `resolveColorVec4`), so by the time this scene's ShaderMaterial
// runs, color is read at offset 0 regardless of its non-zero offset in the source glTF. Only
// POSITION keeps the source's non-canonical byteStride (28 instead of the tight 12), so this
// scene proves that a non-canonical *stride* is honoured, not a non-zero per-attribute
// *offset* — the latter is covered separately by a synthetic-layout unit test, since no real
// loader path currently produces a non-zero-offset attribute for the ShaderMaterial pipeline.
import { addToScene, createArcRotateCamera, createEngine, createSceneContext, createShaderMaterial, loadGltf, registerScene, startEngine } from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";

const MODEL_URL = "/gltf-assets/Buffer_Interleaved/Buffer_Interleaved_03.gltf";

const vertexSource = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) color:vec3<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);
    out.color=input.color.rgb;
    return out;
}`;

const fragmentSource = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) color:vec3<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
    return vec4<f32>(input.color,1.0);
}`;

function collectMeshes(node: unknown, out: Mesh[]): void {
    const n = node as { _gpu?: unknown; children?: unknown[] };
    if (n._gpu) {
        out.push(node as Mesh);
    }
    for (const child of n.children ?? []) {
        collectMeshes(child, out);
    }
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1.3, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;

    const container = await loadGltf(engine, MODEL_URL);
    const meshes: Mesh[] = [];
    for (const entity of container.entities) {
        collectMeshes(entity, meshes);
    }
    meshes[0]!.material = createShaderMaterial({
        name: "interleavedVertexColor",
        vertexSource,
        fragmentSource,
        attributes: ["position", "color"],
        uniforms: ["worldViewProjection"],
    }) as unknown as Mesh["material"];

    addToScene(scene, container);
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
