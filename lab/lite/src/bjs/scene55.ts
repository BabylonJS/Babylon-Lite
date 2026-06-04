import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.1, 0.12, 0.16, 1);

    const camera = new FreeCamera("camera", new Vector3(0, 0, -6), scene);
    camera.setTarget(new Vector3(0, 0, 1.2));
    camera.fov = 0.8;
    camera.minZ = 1;
    camera.maxZ = 100;

    const manager = new SpriteManager("sorted-billboards", getSpriteAtlasDataUrl(), 3, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene, 0);
    manager.disableDepthWrite = true;

    addSprite(manager, "far", [0.35, 0.2, 2.4], [2.7, 2.7], 8, [1, 1, 1, 0.58]);
    addSprite(manager, "middle", [0, 0, 1.2], [2.7, 2.7], 13, [1, 1, 1, 0.58]);
    addSprite(manager, "near", [-0.35, -0.2, 0], [2.7, 2.7], 18, [1, 1, 1, 0.58]);

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
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});

function addSprite(
    manager: SpriteManager,
    name: string,
    position: readonly [number, number, number],
    size: readonly [number, number],
    frame: number,
    color: readonly [number, number, number, number]
): Sprite {
    const sprite = new Sprite(name, manager);
    sprite.position = new Vector3(position[0], position[1], position[2]);
    sprite.width = size[0];
    sprite.height = size[1];
    sprite.cellIndex = frame;
    sprite.color = new Color4(color[0], color[1], color[2], color[3]);
    sprite.isVisible = true;
    return sprite;
}
