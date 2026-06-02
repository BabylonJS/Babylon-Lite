// Reference scene 52 - HUD on 3D (BJS).
//
// Mirrors lab/lite/src/lite/scene52.ts with two BJS passes: a regular Scene for the
// StandardMaterial sphere, then a thin SpriteRenderer pass for the pixel-space
// HUD. The SpriteRenderer path is the same low-level BJS sprite oracle used by
// scenes 50/51, which keeps the HUD coordinates comparable to Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

// SpriteRenderer calls engine.setAlphaMode(...); import the extension explicitly
// so the thin BJS oracle path has the same dependency in every environment.
import "@babylonjs/core/Engines/Extensions/engine.alpha";
// Force WGSL sprite shaders into the main bundle instead of a one-off dynamic fetch.
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2, 5, new Vector3(0, 0, 0), scene);
    cam.minZ = 1;
    cam.maxZ = 10000;

    const light = new DirectionalLight("dir", new Vector3(0, -1, 0), scene);
    light.diffuse = new Color3(1, 0, 0);
    light.specular = new Color3(0, 1, 0);

    MeshBuilder.CreateSphere("sphere", { segments: 32 }, scene);

    const texture = new Texture(getSpriteAtlasDataUrl(), engine, true, false, Texture.BILINEAR_SAMPLINGMODE);
    const renderer = new SpriteRenderer(engine, 16, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = SPRITE_ATLAS_INFO.cellWidthPx;
    renderer.cellHeight = SPRITE_ATLAS_INFO.cellHeightPx;
    renderer.disableDepthWrite = true;

    const hudSprites = buildHudSprites(canvas);
    const hudView = Matrix.LookAtLH(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    const hudProjection = Matrix.OrthoOffCenterLH(0, canvas.width, 0, canvas.height, 0.1, 100, engine.isNDCHalfZRange);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    const rendererInternal = renderer as unknown as { _shadersLoaded: boolean };

    let firstFrame = true;
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => {
        eng._drawCalls?.fetchNewFrame();
        scene.render();
        renderer.render(hudSprites, 0, hudView, hudProjection);
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
        if (firstFrame && texture.isReady() && rendererInternal._shadersLoaded) {
            firstFrame = false;
            resolveReady();
        }
    });
    window.addEventListener("resize", () => engine.resize());
    await readyPromise;
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});

function createHudSprite(canvas: HTMLCanvasElement, x: number, y: number, size: number, frame: number, color: Color4): ThinSprite {
    const sprite = new ThinSprite();
    sprite.position = new Vector3(x, canvas.height - y, 0);
    sprite.width = size;
    sprite.height = size;
    sprite.cellIndex = frame;
    sprite.color = color;
    sprite.isVisible = true;
    return sprite;
}

function buildHudSprites(canvas: HTMLCanvasElement): ThinSprite[] {
    const sprites: ThinSprite[] = [];
    for (let i = 0; i < 8; i++) {
        sprites.push(createHudSprite(canvas, 70 + i * 44, 58, 34, 8 + i, i < 5 ? new Color4(1, 1, 1, 1) : new Color4(0.35, 0.35, 0.35, 1)));
    }
    for (let i = 0; i < 4; i++) {
        sprites.push(
            createHudSprite(canvas, canvas.width / 2 - 72 + i * 48, canvas.height / 2 + 92, 38, 16 + i, i % 2 === 0 ? new Color4(1, 1, 1, 1) : new Color4(0.7, 1, 0.85, 1))
        );
    }
    sprites.push(createHudSprite(canvas, canvas.width / 2, canvas.height / 2, 56, 24, new Color4(1, 0.85, 0.65, 1)));
    return sprites;
}
