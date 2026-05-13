import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
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
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const CAMERA_ALPHA = -Math.PI / 4;
const CAMERA_BETA = 1.15;
const LOCK_AXIS = new Vector3(0.35, 1, 0.2).normalize();

// Babylon.js has no matching built-in axis-locked billboard primitive here. This reference
// bakes the static camera-pose basis once for visual parity, not for camera-motion behavior.

interface SpriteCell {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame: number;
    color?: [number, number, number, number];
    flipX?: boolean;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.14, 0.16, 0.2, 1);

    const camera = new ArcRotateCamera("camera", CAMERA_ALPHA, CAMERA_BETA, 10, new Vector3(0, 1, 0), scene);
    camera.minZ = 1;
    camera.maxZ = 100;

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.85;

    const box1 = MeshBuilder.CreateBox("box1", { size: 1.2 }, scene);
    box1.position = new Vector3(-2.5, 0.6, 0);
    const mat1 = new StandardMaterial("mat1", scene);
    mat1.diffuseColor = new Color3(0.4, 0.5, 0.7);
    box1.material = mat1;

    const box2 = MeshBuilder.CreateBox("box2", { size: 1.2 }, scene);
    box2.position = new Vector3(2.5, 0.6, 0);
    const mat2 = new StandardMaterial("mat2", scene);
    mat2.diffuseColor = new Color3(0.7, 0.5, 0.4);
    box2.material = mat2;

    const box3 = MeshBuilder.CreateBox("box3", { size: 0.8 }, scene);
    box3.position = new Vector3(0, 0.4, 2.8);
    const mat3 = new StandardMaterial("mat3", scene);
    mat3.diffuseColor = new Color3(0.5, 0.7, 0.5);
    box3.material = mat3;

    const atlasTexture = new Texture(getSpriteAtlasDataUrl(), scene, false, false, Texture.LINEAR_LINEAR);

    const sprites: SpriteCell[] = [
        { position: [-2.5, 2.2, 0], sizeWorld: [1.4, 0.9], frame: 5, color: [1, 1, 1, 0.92] },
        { position: [2.5, 2.2, 0], sizeWorld: [1.3, 0.85], frame: 11, color: [1, 1, 1, 0.88], flipX: true },
        { position: [0, 1.8, 2.8], sizeWorld: [1.1, 0.75], frame: 17, color: [1, 1, 1, 0.85] },
        { position: [-1.2, 3, -1.5], sizeWorld: [1.5, 1], frame: 23, color: [1, 1, 1, 0.9] },
    ];

    const cellsPerRow = SPRITE_ATLAS_INFO.columns;
    const basis = computeAxisLockedBasis(camera, LOCK_AXIS);

    sprites.forEach((sprite, index) => {
        const plane = createAxisLockedSpritePlane(`sprite${index}`, sprite, scene, cellsPerRow, basis.right, basis.up);

        const material = new StandardMaterial(`spriteMat${index}`, scene);
        material.diffuseTexture = atlasTexture.clone();
        material.diffuseTexture!.hasAlpha = true;
        material.useAlphaFromDiffuseTexture = true;
        material.transparencyMode = Material.MATERIAL_ALPHABLEND;
        material.disableDepthWrite = true;
        material.disableLighting = true;
        material.emissiveColor = new Color3(1, 1, 1);
        material.backFaceCulling = false;

        if (sprite.color) {
            material.diffuseColor = new Color3(sprite.color[0], sprite.color[1], sprite.color[2]);
            material.alpha = sprite.color[3];
        }

        plane.material = material;
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
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});

interface AxisLockedBasis {
    right: Vector3;
    up: Vector3;
}

function computeAxisLockedBasis(camera: ArcRotateCamera, lockAxis: Vector3): AxisLockedBasis {
    const view = camera.getViewMatrix().m;
    const cameraRight = new Vector3(view[0], view[4], view[8]).normalize();
    const projectedRight = cameraRight.subtract(lockAxis.scale(Vector3.Dot(cameraRight, lockAxis)));
    const projectedRightLen = projectedRight.length();
    const fallbackSeed = Math.abs(lockAxis.z) > 0.999 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
    const fallbackRight = Vector3.Cross(lockAxis, fallbackSeed).normalize();
    return {
        right: projectedRightLen > 1e-4 ? projectedRight.scale(1 / projectedRightLen) : fallbackRight,
        up: lockAxis.scale(-1),
    };
}

function createAxisLockedSpritePlane(name: string, sprite: SpriteCell, scene: Scene, cellsPerRow: number, right: Vector3, up: Vector3): Mesh {
    const pivot: [number, number] = [0.5, 0.5];
    const width = sprite.sizeWorld[0];
    const height = sprite.sizeWorld[1];

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
        const worldPos = right.scale(localX).add(up.scale(localY));
        positions.push(worldPos.x, worldPos.y, worldPos.z);
    });

    const normals = corners.flatMap(() => {
        const normal = Vector3.Cross(right, up);
        return [normal.x, normal.y, normal.z];
    });

    const row = Math.floor(sprite.frame / cellsPerRow);
    const col = sprite.frame % cellsPerRow;
    const uvMinX = col / cellsPerRow;
    const uvMinY = row / SPRITE_ATLAS_INFO.rows;
    const uvMaxX = (col + 1) / cellsPerRow;
    const uvMaxY = (row + 1) / SPRITE_ATLAS_INFO.rows;
    const u0 = sprite.flipX ? uvMaxX : uvMinX;
    const u1 = sprite.flipX ? uvMinX : uvMaxX;
    const uvs = [u0, uvMinY, u1, uvMinY, u1, uvMaxY, u0, uvMaxY];

    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.indices = [0, 1, 2, 0, 2, 3];
    vertexData.applyToMesh(mesh);
    mesh.position = new Vector3(...sprite.position);
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
    return mesh;
}
