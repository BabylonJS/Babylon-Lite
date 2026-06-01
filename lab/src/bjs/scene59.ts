import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import {
    createManualSpriteAnimation,
    PLAYER_SPRITE_INFO,
    PLAYER_SPRITE_URL,
    seekManualSpriteAnimations,
    updateManualSpriteAnimations,
    type ManualSpriteAnimation,
} from "../_shared/player-sprite";

const CAMERA_POSITION = new Vector3(0, 1.05, -5.6);
const CAMERA_TARGET = new Vector3(0, 0.25, 0.75);

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.07, 0.09, 0.12, 1);

    const camera = new FreeCamera("camera", CAMERA_POSITION, scene);
    camera.setTarget(CAMERA_TARGET);
    camera.fov = 0.68;
    camera.minZ = 0.5;
    camera.maxZ = 80;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.92;
    addBox(scene, [0, -0.86, 1.2], [4.8, 0.16, 3.2], [0.32, 0.29, 0.25]);
    addBox(scene, [0, 0.58, 2.55], [4.8, 1.8, 0.12], [0.15, 0.22, 0.3]);
    addBox(scene, [-1.65, -0.05, 1.45], [0.28, 1.55, 0.2], [0.8, 0.24, 0.2]);
    addBox(scene, [1.65, -0.05, 1.45], [0.28, 1.55, 0.2], [0.25, 0.48, 0.95]);

    const spriteManager = new SpriteManager("players", PLAYER_SPRITE_URL, 4, { width: PLAYER_SPRITE_INFO.frameWidthPx, height: PLAYER_SPRITE_INFO.frameHeightPx }, scene, 0);
    spriteManager.disableDepthWrite = true;

    const animations: ManualSpriteAnimation[] = [];
    const mainRunner = addPlayerSprite(spriteManager, "main-runner", [0, -0.155, 0.15], [1.25, 1.25], [1, 1, 1, 1]);
    const reverseRunner = addPlayerSprite(spriteManager, "reverse-runner", [-1.28, -0.205, 0.95], [0.95, 0.95], [0.65, 0.85, 1, 0.82], true);
    const finishRunner = addPlayerSprite(spriteManager, "finish-runner", [1.28, -0.22, 0.82], [0.8, 0.8], [1, 0.85, 0.7, 0.78]);

    animations.push(createManualSpriteAnimation(mainRunner, PLAYER_SPRITE_INFO.runStartFrame, PLAYER_SPRITE_INFO.runEndFrame, true, PLAYER_SPRITE_INFO.delayMs));
    animations.push(createManualSpriteAnimation(reverseRunner, PLAYER_SPRITE_INFO.runEndFrame, PLAYER_SPRITE_INFO.runStartFrame, true, PLAYER_SPRITE_INFO.delayMs));
    animations.push(createManualSpriteAnimation(finishRunner, 0, 6, false, PLAYER_SPRITE_INFO.delayMs, true));

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    const hasSeekTime = Number.isFinite(seekTime);
    if (hasSeekTime) {
        seekManualSpriteAnimations(animations, seekTime);
        canvas.dataset.animationFrozen = "true";
    }

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        if (!hasSeekTime) {
            updateManualSpriteAnimations(animations, engine.getDeltaTime());
        }
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

function addBox(scene: Scene, position: [number, number, number], scale: [number, number, number], color: [number, number, number]): void {
    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position = new Vector3(position[0], position[1], position[2]);
    box.scaling = new Vector3(scale[0], scale[1], scale[2]);
    const material = new StandardMaterial("boxMat", scene);
    material.diffuseColor = new Color3(color[0], color[1], color[2]);
    box.material = material;
}

function addPlayerSprite(
    spriteManager: SpriteManager,
    name: string,
    position: readonly [number, number, number],
    sizeWorld: readonly [number, number],
    color: readonly [number, number, number, number],
    flipX = false
): Sprite {
    const sprite = new Sprite(name, spriteManager);
    sprite.position = new Vector3(position[0], position[1], position[2]);
    sprite.width = sizeWorld[0];
    sprite.height = sizeWorld[1];
    sprite.cellIndex = 0;
    sprite.color = new Color4(color[0], color[1], color[2], color[3]);
    sprite.invertU = flipX;
    sprite.isVisible = true;
    return sprite;
}

main().catch((error) => {
    console.error(error);
});