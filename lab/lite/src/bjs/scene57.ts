import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";

const CAMERA_POSITION = new Vector3(0, 1.05, -6);
const CAMERA_TARGET = new Vector3(0, 0.75, 1.0);

interface CutoutCard {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame: number;
    rotation?: number;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.09, 0.11, 0.14, 1);

    const camera = new FreeCamera("camera", CAMERA_POSITION, scene);
    camera.setTarget(CAMERA_TARGET);
    camera.fov = 0.72;
    camera.minZ = 0.5;
    camera.maxZ = 80;

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    addBox(scene, [0, 0.65, 2.45], [5.2, 2.45, 0.12], [0.18, 0.24, 0.32]);
    addBox(scene, [-1.45, 0.7, 2.25], [0.42, 2.15, 0.18], [0.85, 0.22, 0.18]);
    addBox(scene, [0, 0.7, 2.18], [0.42, 2.15, 0.18], [0.22, 0.68, 0.34]);
    addBox(scene, [1.45, 0.7, 2.25], [0.42, 2.15, 0.18], [0.28, 0.45, 0.92]);
    addBox(scene, [0, -0.75, 0.95], [4.8, 0.16, 3.4], [0.38, 0.34, 0.27]);
    addBox(scene, [1.3, 0.05, -0.05], [0.95, 0.95, 0.95], [0.63, 0.55, 0.42]);

    const atlasTexture = new Texture(getCutoutSpriteAtlasDataUrl(), scene, {
        noMipmap: true,
        invertY: false,
        samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    atlasTexture.hasAlpha = true;

    const cutoutMaterial = new StandardMaterial("cutout-billboards", scene);
    cutoutMaterial.diffuseTexture = atlasTexture;
    cutoutMaterial.useAlphaFromDiffuseTexture = true;
    cutoutMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
    cutoutMaterial.alphaCutOff = 0.5;
    cutoutMaterial.disableDepthWrite = false;
    cutoutMaterial.disableLighting = true;
    cutoutMaterial.emissiveColor = new Color3(1, 1, 1);
    cutoutMaterial.backFaceCulling = false;

    const basis = computeFacingBasis(camera);
    const cards: CutoutCard[] = [
        { position: [0, 0.75, 0.15], sizeWorld: [2.35, 2.35], frame: 3 },
        { position: [-0.8, 0.65, 1.15], sizeWorld: [1.75, 2.1], frame: 0 },
        { position: [0.95, 0.45, 0.95], sizeWorld: [1.45, 1.55], frame: 1, rotation: 0.1 },
        { position: [-1.45, -0.15, -0.35], sizeWorld: [1.25, 1.55], frame: 2, rotation: -0.12 },
    ];
    cards.forEach((card, index) => {
        const plane = createFacingSpritePlane(`cutout${index}`, card, scene, basis.right, basis.up);
        plane.material = cutoutMaterial;
    });

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});

interface FacingBasis {
    right: Vector3;
    up: Vector3;
}

function addBox(scene: Scene, position: [number, number, number], scale: [number, number, number], color: [number, number, number]): void {
    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position = new Vector3(position[0], position[1], position[2]);
    box.scaling = new Vector3(scale[0], scale[1], scale[2]);
    const material = new StandardMaterial("boxMat", scene);
    material.diffuseColor = new Color3(color[0], color[1], color[2]);
    box.material = material;
}

function computeFacingBasis(camera: FreeCamera): FacingBasis {
    const view = camera.getViewMatrix().m;
    const cameraRight = new Vector3(view[0], view[4], view[8]).normalize();
    const cameraUp = new Vector3(view[1], view[5], view[9]).normalize();
    return { right: cameraRight, up: cameraUp.scale(-1) };
}

function createFacingSpritePlane(name: string, card: CutoutCard, scene: Scene, right: Vector3, up: Vector3): Mesh {
    const pivot: [number, number] = [0.5, 0.5];
    const width = card.sizeWorld[0];
    const height = card.sizeWorld[1];
    const rotation = card.rotation ?? 0;
    const cosRot = Math.cos(rotation);
    const sinRot = Math.sin(rotation);

    const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
    ];
    const positions: number[] = [];
    corners.forEach(([x, y]) => {
        const localX = (x - pivot[0]) * width;
        const localY = (y - pivot[1]) * height;
        const rotatedX = localX * cosRot - localY * sinRot;
        const rotatedY = localX * sinRot + localY * cosRot;
        const worldPos = right.scale(rotatedX).add(up.scale(rotatedY));
        positions.push(worldPos.x, worldPos.y, worldPos.z);
    });

    const normal = Vector3.Cross(right, up).normalize();
    const normals = corners.flatMap(() => [normal.x, normal.y, normal.z]);

    const cellsPerRow = CUTOUT_SPRITE_ATLAS_INFO.columns;
    const row = Math.floor(card.frame / cellsPerRow);
    const col = card.frame % cellsPerRow;
    const uvMinX = col / cellsPerRow;
    const uvMinY = row / CUTOUT_SPRITE_ATLAS_INFO.rows;
    const uvMaxX = (col + 1) / cellsPerRow;
    const uvMaxY = (row + 1) / CUTOUT_SPRITE_ATLAS_INFO.rows;
    const uvs = [uvMinX, uvMinY, uvMaxX, uvMinY, uvMaxX, uvMaxY, uvMinX, uvMaxY];

    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.indices = [0, 1, 2, 0, 2, 3];
    vertexData.applyToMesh(mesh);
    mesh.position = new Vector3(card.position[0], card.position[1], card.position[2]);
    return mesh;
}