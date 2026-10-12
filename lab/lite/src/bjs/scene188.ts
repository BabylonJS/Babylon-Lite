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
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import {
    buildScene188Indices,
    buildScene188Slab,
    SCENE188_CHUNKS,
    SCENE188_CHUNK_ORIGINS,
    SCENE188_STRIDE,
    SCENE188_VERTS_PER_CHUNK,
} from "../shared/scene188-compute-geometry.js";

ShaderStore.ShadersStoreWGSL.scene188VertexShader = `#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position:vec4f;
varying shade:f32;
@vertex fn main(input:VertexInputs)->FragmentInputs{vertexOutputs.position=scene.viewProjection*mesh.world*vec4f(vertexInputs.position.xyz,1);vertexOutputs.shade=vertexInputs.position.w;}`;
ShaderStore.ShadersStoreWGSL.scene188FragmentShader = `varying shade:f32;
@fragment fn main(input:FragmentInputs)->FragmentOutputs{let t=clamp(fragmentInputs.shade*0.9+0.5,0,1);fragmentOutputs.color=vec4f(0.1+t*0.35,0.35+t*0.5,0.55+t*0.4,1);}`;
void (async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const scene = new Scene(engine);
    scene.clearColor = new Color4(51 / 255, 51 / 255, 76 / 255, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3.1, 7.5, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const material = new ShaderMaterial(
        "scene188-material",
        scene,
        { vertex: "scene188", fragment: "scene188" },
        { attributes: ["position"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
    );
    const slab = new StorageBuffer(
        engine,
        SCENE188_CHUNKS * SCENE188_VERTS_PER_CHUNK * SCENE188_STRIDE,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_VERTEX | Constants.BUFFER_CREATIONFLAG_WRITE,
        "scene188-terrain"
    );
    slab.update(buildScene188Slab());
    const indices = buildScene188Indices();
    for (let i = 0; i < SCENE188_CHUNKS; i++) {
        const mesh = new Mesh(`chunk${i}`, scene);
        const geometry = new Geometry(`chunk${i}-geometry`, scene);
        geometry.setVerticesBuffer(
            new VertexBuffer(engine, slab.getBuffer(), VertexBuffer.PositionKind, {
                size: 4,
                stride: SCENE188_STRIDE,
                offset: i * SCENE188_VERTS_PER_CHUNK * SCENE188_STRIDE,
                type: VertexBuffer.FLOAT,
                useBytes: true,
                updatable: false,
            }),
            SCENE188_VERTS_PER_CHUNK
        );
        geometry.setIndices(indices, SCENE188_VERTS_PER_CHUNK);
        geometry.applyToMesh(mesh);
        mesh.material = material;
        const [ox, oz] = SCENE188_CHUNK_ORIGINS[i]!;
        mesh.buildBoundingInfo(new Vector3(ox, -0.5, oz), new Vector3(ox + 2, 0.5, oz + 2));
    }

    const drawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => drawCalls._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => (canvas.dataset.drawCalls = String(drawCalls._drawCalls?.current ?? 0)));
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
