import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";

const vertexSource = `#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position: vec3<f32>;
#include<instancesDeclaration>
varying vColor: vec4<f32>;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    var positionUpdated = vertexInputs.position;
    #include<instancesVertex>
    vertexOutputs.position = scene.viewProjection * finalWorld * vec4<f32>(positionUpdated, 1.0);
    vertexOutputs.vColor = vertexInputs.instanceColor;
}`;

const fragmentSource = `varying vColor: vec4<f32>;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = fragmentInputs.vColor;
}`;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const camera = new ArcRotateCamera("camera", -Math.PI / 5, Math.PI / 3, 40, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);

    const material = new ShaderMaterial(
        "scene165Shader",
        scene,
        { vertexSource, fragmentSource },
        { attributes: ["position"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
    );

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.material = material;

    const numPerSide = 8;
    const size = 14;
    const ofst = size / (numPerSide - 1);
    const instanceCount = numPerSide * numPerSide * numPerSide;

    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);

    const m = Matrix.Identity();
    let col = 0;
    let index = 0;
    for (let x = 0; x < numPerSide; x++) {
        (m.m as number[])[12] = -size / 2 + ofst * x;
        for (let y = 0; y < numPerSide; y++) {
            (m.m as number[])[13] = -size / 2 + ofst * y;
            for (let z = 0; z < numPerSide; z++) {
                (m.m as number[])[14] = -size / 2 + ofst * z;
                m.copyToArray(matricesData, index * 16);

                const coli = Math.floor(col);
                colorData[index * 4 + 0] = ((coli & 0xff0000) >> 16) / 255;
                colorData[index * 4 + 1] = ((coli & 0x00ff00) >> 8) / 255;
                colorData[index * 4 + 2] = ((coli & 0x0000ff) >> 0) / 255;
                colorData[index * 4 + 3] = 1.0;

                index++;
                col += 0xffffff / instanceCount;
            }
        }
    }

    box.thinInstanceSetBuffer("matrix", matricesData, 16);
    box.thinInstanceSetBuffer("color", colorData, 4);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
