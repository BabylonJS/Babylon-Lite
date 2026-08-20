import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

// Same scene as the Lite side: the interleaved glTF mesh drawn by a ShaderMaterial that
// reads POSITION (offset 0) and COLOR_0 (offset 12) out of one byteStride-28 bufferView.
const MODEL_URL = "/gltf-assets/Buffer_Interleaved/Buffer_Interleaved_03.gltf";

ShaderStore.ShadersStoreWGSL["interleavedVertexColorVertexShader"] = `
#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position: vec3<f32>;
attribute color: vec4<f32>;
varying vColor: vec3<f32>;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = scene.viewProjection * mesh.world * vec4<f32>(vertexInputs.position, 1.0);
    vertexOutputs.vColor = vertexInputs.color.rgb;
}`;

ShaderStore.ShadersStoreWGSL["interleavedVertexColorFragmentShader"] = `
varying vColor: vec3<f32>;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4<f32>(fragmentInputs.vColor, 1.0);
}`;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 2, 1.3, Vector3.Zero(), scene);
    camera.minZ = 0.01;

    const result = await SceneLoader.ImportMeshAsync("", MODEL_URL.substring(0, MODEL_URL.lastIndexOf("/") + 1), MODEL_URL.substring(MODEL_URL.lastIndexOf("/") + 1), scene);
    const mesh = result.meshes.find((m) => m.getTotalVertices() > 0)!;

    mesh.material = new ShaderMaterial(
        "interleavedVertexColor",
        scene,
        { vertex: "interleavedVertexColor", fragment: "interleavedVertexColor" },
        { attributes: ["position", "color"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
    );

    scene.render();
    engine.runRenderLoop(() => scene.render());
    await new Promise((r) => setTimeout(r, 400));
    canvas.dataset.drawCalls = String(scene.getActiveMeshes().length);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
