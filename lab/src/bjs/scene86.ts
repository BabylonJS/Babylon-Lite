// BJS reference for scene 86 — parses the same NME scene/mesh-state JSON as Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { createScene86MeshData, SCENE86_CLIP_PLANE, SCENE86_NME_JSON } from "../shared/scene86-nme.js";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.02, 0.035, 1);
    scene.clipPlane = new Plane(SCENE86_CLIP_PLANE[0], SCENE86_CLIP_PLANE[1], SCENE86_CLIP_PLANE[2], SCENE86_CLIP_PLANE[3]);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 4, new Vector3(0, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const material = NodeMaterial.Parse(SCENE86_NME_JSON, scene);
    material.build(false);
    material.backFaceCulling = false;

    for (const data of createScene86MeshData()) {
        const mesh = new Mesh(data.name, scene);
        const vertexData = new VertexData();
        vertexData.positions = Array.from(data.positions);
        vertexData.normals = Array.from(data.normals);
        vertexData.indices = Array.from(data.indices);
        if (data.uvs) {
            vertexData.uvs = Array.from(data.uvs);
        }
        vertexData.applyToMesh(mesh);
        if (data.tangents) {
            mesh.setVerticesData(VertexBuffer.TangentKind, Array.from(data.tangents));
        }
        if (data.colors) {
            mesh.setVerticesData(VertexBuffer.ColorKind, Array.from(data.colors));
        }
        mesh.position.x = data.x;
        mesh.material = material;
    }

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
