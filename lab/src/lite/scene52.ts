// Scene 52 - HUD-on-3D
//
// 3D scene (sphere + StandardMaterial under a directional light) with a
// pure-2D HUD sprite overlay rendered AFTER the 3D pass via the
// `SpriteRenderer` rendering context. The HUD layer uses `depth: "none"`
// so it does not consume the engine's depth attachment. It is the same
// route as scenes 50/51, layered on top of a regular 3D scene.
//
// Demonstrates explicit composition: the user wires `addToScene` for 3D
// entities and `createSpriteRenderer / registerSpriteRenderer` for the HUD;
// there is no hidden HUD scaffolding inside the scene context.
//
// Lifecycle: the HUD renderer is independent of the scene, but we tie its
// disposal to the scene via `onSceneDispose` so `disposeScene` cleans up the
// HUD's GPU buffers.

import {
    addSprite2DIndex,
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createSceneContext,
    createSphere,
    createSprite2DLayer,
    createSpriteRenderer,
    createStandardMaterial,
    disposeSpriteRenderer,
    loadSpriteAtlas,
    onSceneDispose,
    registerScene,
    registerSpriteRenderer,
    startEngine,
} from "babylon-lite";
import type { Sprite2DLayer } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;

    const light = createDirectionalLight([0, -1, 0]);
    light.diffuse = [1, 0, 0];
    light.specular = [0, 1, 0];
    addToScene(scene, light);

    const sphere = createSphere(engine);
    sphere.material = createStandardMaterial();
    addToScene(scene, sphere);

    await registerScene(engine, scene);

    // HUD overlay: a separate `SpriteRenderer` rendering context, registered
    // after the scene so it draws on top in engine render-list order.
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const hud = createSprite2DLayer(atlas, { capacity: 16, blendMode: "alpha", depth: "none" });
    addHudSprites(hud, canvas);
    const hudRenderer = createSpriteRenderer(engine, { layers: [hud], clear: false });
    registerSpriteRenderer(hudRenderer);
    // Tie HUD disposal to the scene. `disposeScene` will fire this callback.
    onSceneDispose(scene, () => disposeSpriteRenderer(hudRenderer));

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

/** Lay out a deterministic HUD: top-row icon strip, center crosshair, and bottom-center action bar. */
function addHudSprites(layer: Sprite2DLayer, canvas: HTMLCanvasElement): void {
    for (let i = 0; i < 8; i++) {
        addSprite2DIndex(layer, {
            positionPx: [70 + i * 44, 58],
            sizePx: [34, 34],
            frame: 8 + i,
            color: i < 5 ? [1, 1, 1, 1] : [0.35, 0.35, 0.35, 1],
        });
    }

    for (let i = 0; i < 4; i++) {
        addSprite2DIndex(layer, {
            positionPx: [canvas.width / 2 - 72 + i * 48, canvas.height / 2 + 92],
            sizePx: [38, 38],
            frame: 16 + i,
            color: i % 2 === 0 ? [1, 1, 1, 1] : [0.7, 1, 0.85, 1],
        });
    }

    addSprite2DIndex(layer, {
        positionPx: [canvas.width / 2, canvas.height / 2],
        sizePx: [56, 56],
        frame: 24,
        color: [1, 0.85, 0.65, 1],
    });
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
