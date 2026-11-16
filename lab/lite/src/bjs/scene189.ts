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
import { buildScene189Indices, buildScene189Slab, SCENE189_VERTICES } from "../shared/scene189-indirect.js";

ShaderStore.ShadersStoreWGSL.scene189VertexShader = `#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position:vec4f;
varying shade:f32;
@vertex fn main(input:VertexInputs)->FragmentInputs{vertexOutputs.position=scene.viewProjection*mesh.world*vec4f(vertexInputs.position.xyz,1);vertexOutputs.shade=vertexInputs.position.w;}`;
ShaderStore.ShadersStoreWGSL.scene189FragmentShader = `varying shade:f32;
@fragment fn main(input:FragmentInputs)->FragmentOutputs{let a=fragmentInputs.shade;fragmentOutputs.color=vec4f(0.15+a*0.75,0.8-a*0.5,0.95-a*0.25,1);}`;

void (async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.04, 0.08, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3.1, 7.5, new Vector3(0, 0.3, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const mesh = new Mesh("indirect-triangles", scene);
    const geometry = new Geometry("indirect-triangles-geometry", scene);
    const slab = new StorageBuffer(
        engine,
        SCENE189_VERTICES * 16,
        Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_VERTEX | Constants.BUFFER_CREATIONFLAG_WRITE,
        "scene189-vertices"
    );
    slab.update(buildScene189Slab());
    geometry.setVerticesBuffer(
        new VertexBuffer(engine, slab.getBuffer(), VertexBuffer.PositionKind, {
            size: 4,
            stride: 16,
            offset: 0,
            type: VertexBuffer.FLOAT,
            useBytes: true,
            updatable: false,
        }),
        SCENE189_VERTICES
    );
    geometry.setIndices(buildScene189Indices(), SCENE189_VERTICES);
    geometry.applyToMesh(mesh);
    const material = new ShaderMaterial(
        "scene189-material",
        scene,
        { vertex: "scene189", fragment: "scene189" },
        { attributes: ["position"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
    );
    material.backFaceCulling = false;
    mesh.material = material;
    mesh.buildBoundingInfo(new Vector3(-2.3, 0, -1.6), new Vector3(2.3, 0.85, 1.6));

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
