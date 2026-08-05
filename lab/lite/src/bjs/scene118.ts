// Babylon.js reference for Scene 118: Billboard Sprite Picking.
// Picks a camera-facing sprite via `scene.pickSprite` and floats a small marker box in front
// of the picked sprite's anchor — the same visual the Lite scene builds from `pickBillboardSprite`.

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import "@babylonjs/core/Sprites/spriteSceneComponent"; // registers scene.pickSprite

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const TARGET_ANCHOR = new Vector3(0, 0, 0);
const MARKER_OFFSET = 0.5;

function createUnlitMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.White();
    material.emissiveColor = color;
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    return material;
}

function createMarker(scene: Scene): AbstractMesh {
    const marker = MeshBuilder.CreateBox("scene118-pick-marker", { size: 1 }, scene);
    marker.material = createUnlitMaterial(scene, "pick-marker-mat", new Color3(1, 0.18, 0.82));
    marker.scaling.set(0.22, 0.22, 0.22);
    marker.position.set(0, -10, 0);
    marker.isPickable = false;
    return marker;
}

function addSprite(manager: SpriteManager, name: string, position: readonly [number, number, number], size: readonly [number, number], frame: number): Sprite {
    const sprite = new Sprite(name, manager);
    sprite.position = new Vector3(position[0], position[1], position[2]);
    sprite.width = size[0];
    sprite.height = size[1];
    sprite.cellIndex = frame;
    sprite.color = new Color4(1, 1, 1, 0.95);
    sprite.isPickable = true;
    return sprite;
}

function formatVector(value: Vector3 | null): string {
    return value ? [value.x, value.y, value.z].map((v) => v.toPrecision(12)).join(",") : "";
}

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.16, 0.18, 0.22, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.4, 7, Vector3.Zero(), scene);
    camera.fov = 0.8;
    camera.minZ = 1;
    camera.maxZ = 100;
    scene.activeCamera = camera;

    const manager = new SpriteManager("billboards", getSpriteAtlasDataUrl(), 4, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene, 0);
    manager.disableDepthWrite = true;
    addSprite(manager, "left", [-2, 0.5, 0], [1.5, 1.5], 8);
    addSprite(manager, "center", [TARGET_ANCHOR.x, TARGET_ANCHOR.y, TARGET_ANCHOR.z], [1.8, 1.8], 13);
    addSprite(manager, "right", [2, -0.5, 0], [1.5, 1.5], 18);

    const marker = createMarker(scene);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    await waitFrames(4);

    const pick = scene.pickSprite(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let markerPlaced = false;
    if (pick?.hit && pick.pickedSprite) {
        const anchor = pick.pickedSprite.position;
        const toCam = camera.position.subtract(anchor);
        toCam.normalize().scaleInPlace(MARKER_OFFSET);
        marker.position.copyFrom(anchor.add(toCam));
        markerPlaced = true;
    }

    await waitFrames(4);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickedHit = pick?.hit ? (pick.pickedSprite?.name ?? "") : "miss";
    canvas.dataset.markerPlaced = String(markerPlaced);
    canvas.dataset.pickPoint = formatVector(pick?.pickedPoint ?? null);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
