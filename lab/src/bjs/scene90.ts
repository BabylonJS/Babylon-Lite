// Babylon.js reference for Scene 90: CSG operations — adapted from playground #0MDAYA.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CSG } from "@babylonjs/core/Meshes/csg";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const GRASS_URL = "https://playground.babylonjs.com/textures/grass.png";
const CRATE_URL = "https://playground.babylonjs.com/textures/crate.png";

interface DrawCallCounter {
    current: number;
    fetchNewFrame?: () => void;
}

function labelTextureUrl(text: string): string {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Scene 90 labels require a 2D canvas context.");
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "black";
    ctx.font = "700 64px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 128, 78);
    return canvas.toDataURL("image/png");
}

function createTextureMaterial(scene: Scene, name: string, url: string): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseTexture = new Texture(url, scene, { invertY: true });
    return material;
}

function createLabelMaterial(scene: Scene, text: string): StandardMaterial {
    const material = new StandardMaterial(`label-${text}`, scene);
    const texture = new Texture(labelTextureUrl(text), scene, {
        noMipmap: true,
        invertY: true,
        samplingMode: Texture.BILINEAR_SAMPLINGMODE,
    });
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    material.alphaCutOff = 0.5;
    material.backFaceCulling = false;
    return material;
}

function setMeshPosition(mesh: Mesh, x: number, y: number, z = 0): void {
    mesh.position.set(x, y, z);
}

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    new ArcRotateCamera("camera", -1.5, 1.6, 18, Vector3.Zero(), scene);
    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);

    const crateMaterial = createTextureMaterial(scene, "crate", CRATE_URL);
    const grassMaterial = createTextureMaterial(scene, "grass", GRASS_URL);
    const resultMaterial = createTextureMaterial(scene, "result", CRATE_URL);
    const subtractLabel = createLabelMaterial(scene, "-");
    const intersectLabel = createLabelMaterial(scene, "∩");
    const unionLabel = createLabelMaterial(scene, "+");
    const equalsLabel = createLabelMaterial(scene, "=");

    const rows: Array<{ y: number; label: StandardMaterial; op: "subtract" | "intersect" | "union" }> = [
        { y: -4, label: subtractLabel, op: "subtract" },
        { y: 0, label: intersectLabel, op: "intersect" },
        { y: 4, label: unionLabel, op: "union" },
    ];

    for (const row of rows) {
        const box = MeshBuilder.CreateBox(`box-${row.op}`, { size: 2 }, scene);
        const sphere = MeshBuilder.CreateSphere(`sphere-${row.op}`, { diameter: 2.5, segments: 32 }, scene);
        box.material = crateMaterial;
        sphere.material = grassMaterial;

        const boxCsg = CSG.FromMesh(box);
        const sphereCsg = CSG.FromMesh(sphere);
        const resultCsg = row.op === "subtract" ? boxCsg.subtract(sphereCsg) : row.op === "intersect" ? boxCsg.intersect(sphereCsg) : boxCsg.union(sphereCsg);
        const result = resultCsg.toMesh(`csg-${row.op}`, resultMaterial, scene);

        setMeshPosition(box, -4, row.y);
        setMeshPosition(sphere, 0.2, row.y);
        setMeshPosition(result, 4, row.y);

        const label = MeshBuilder.CreatePlane(`label-${row.op}`, { width: 1.4, height: 0.7 }, scene);
        label.material = row.label;
        setMeshPosition(label, -2, row.y);

        const equals = MeshBuilder.CreatePlane(`equals-${row.op}`, { width: 1.4, height: 0.7 }, scene);
        equals.material = equalsLabel;
        setMeshPosition(equals, 2, row.y);
    }

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: DrawCallCounter };
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
