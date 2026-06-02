import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

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

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();

    const texture = new Texture(PLAYER_SPRITE_URL, engine, true, false, Texture.BILINEAR_SAMPLINGMODE);
    const renderer = new SpriteRenderer(engine, 4, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = PLAYER_SPRITE_INFO.frameWidthPx;
    renderer.cellHeight = PLAYER_SPRITE_INFO.frameHeightPx;
    renderer.disableDepthWrite = true;

    const centerX = canvas.width * 0.5;
    const sprites: ThinSprite[] = [];
    const animations: ManualSpriteAnimation[] = [];
    const mainRunner = addThinPlayerSprite(sprites, canvas, centerX, 410, [192, 192], [1, 1, 1, 1]);
    const reverseRunner = addThinPlayerSprite(sprites, canvas, centerX - 235, 430, [128, 128], [0.65, 0.85, 1, 0.82], true);
    const finishRunner = addThinPlayerSprite(sprites, canvas, centerX + 235, 430, [128, 128], [1, 0.85, 0.7, 0.78]);

    animations.push(createManualSpriteAnimation(mainRunner, PLAYER_SPRITE_INFO.runStartFrame, PLAYER_SPRITE_INFO.runEndFrame, true, PLAYER_SPRITE_INFO.delayMs));
    animations.push(createManualSpriteAnimation(reverseRunner, PLAYER_SPRITE_INFO.runEndFrame, PLAYER_SPRITE_INFO.runStartFrame, true, PLAYER_SPRITE_INFO.delayMs));
    animations.push(createManualSpriteAnimation(finishRunner, 0, 6, false, PLAYER_SPRITE_INFO.delayMs, true));

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    const hasSeekTime = Number.isFinite(seekTime);
    if (hasSeekTime) {
        seekManualSpriteAnimations(animations, seekTime);
        canvas.dataset.animationFrozen = "true";
    }

    const view = Matrix.LookAtLH(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    const projection = Matrix.OrthoOffCenterLH(0, canvas.width, 0, canvas.height, 0.1, 100, engine.isNDCHalfZRange);
    const clearColor = new Color4(0.07, 0.09, 0.12, 1);
    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    const rendererInternal = renderer as unknown as { _shadersLoaded: boolean };
    let lastTime = 0;
    let firstFrame = true;
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });

    engine.runRenderLoop(() => {
        const now = performance.now();
        const deltaMs = lastTime > 0 ? now - lastTime : 0;
        lastTime = now;
        if (!hasSeekTime) {
            updateManualSpriteAnimations(animations, deltaMs);
        }

        engineWithDrawCalls._drawCalls?.fetchNewFrame();
        engine.clear(clearColor, true, true, true);
        renderer.render(sprites, 0, view, projection);
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
        if (firstFrame && texture.isReady() && rendererInternal._shadersLoaded) {
            firstFrame = false;
            resolveReady();
        }
    });
    window.addEventListener("resize", () => engine.resize());

    await readyPromise;
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

function addThinPlayerSprite(
    sprites: ThinSprite[],
    canvas: HTMLCanvasElement,
    positionX: number,
    positionY: number,
    sizePx: readonly [number, number],
    color: readonly [number, number, number, number],
    flipX = false
): ThinSprite {
    const sprite = new ThinSprite();
    sprite.position = new Vector3(positionX, canvas.height - positionY, 0);
    sprite.width = sizePx[0];
    sprite.height = sizePx[1];
    sprite.cellIndex = 0;
    sprite.color = new Color4(color[0], color[1], color[2], color[3]);
    sprite.invertU = flipX;
    sprite.isVisible = true;
    sprites.push(sprite);
    return sprite;
}

main().catch((error) => {
    console.error(error);
});