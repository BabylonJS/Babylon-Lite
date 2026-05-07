// Scene 53 — Depth-Hosted Sprites With Per-Instance Z
//
// Showcases TWO things at once, both new in PR3:
//   1. Sprites participating in the scene's depth attachment via
//      `addDepthHostedSpriteLayer(scene, layer)` + `depth: "test-write"` — they can occlude /
//      be occluded by 3D meshes.
//   2. Per-instance Z (slot [10] of the per-instance vertex buffer) —
//      multiple sprites in the SAME layer at DIFFERENT depths.
//
// Setup (1280×720 canvas, FoV=0.8, near=1, far=100):
//   - Camera at (0, 0, -8) looking +Z (origin at frame centre).
//   - Front-left RED box at world (-1.5, 0, -2), size 2 → NDC.z ≈ 0.842,
//     covers screen x ≈ [285, 569].
//   - Back-right BLUE box at world (1.5, 0, 2), size 2 → NDC.z ≈ 0.909,
//     covers screen x ≈ [683, 853].
//
// Three sprites in one `Sprite2DLayer`, side-by-side at canvas centre,
// each carrying its own per-instance `z`:
//   - Sprite A (yellow "0", z=0.6)  → IN FRONT of both boxes; occludes the
//     red box where they overlap.
//   - Sprite B (cyan "1",  z=0.87) → BETWEEN the boxes; the red box
//     occludes B's left edge; B occludes the blue box's left edge.
//   - Sprite C (magenta "2", z=0.95) → BEHIND both boxes; the blue box
//     occludes most of C; only C's right edge peeks out.
//
// The intra-layer sprite ordering also follows per-instance Z: where
// sprites overlap each other, the lower-z sprite wins.

import {
    addDepthHostedSpriteLayer,
    addSprite2DIndex,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createSprite2DLayer,
    createStandardMaterial,
    loadSpriteAtlas,
    onBeforeRender,
    registerScene,
    startEngine,
    updateSprite2DIndex,
} from "babylon-lite";
import type { Sprite2DLayer } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const DESIGN_HEIGHT = 720;
const SPRITE_SIZE = 180;
const SPRITE_SPACING = 200;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera at (0, 0, -8) looking at origin (+Z is into the scene). Standard
    // PerspectiveLH(fov=0.8, near=1, far=100) → world z=-2 → NDC.z≈0.842,
    // world z=2 → NDC.z≈0.909. Sprite per-instance z values are picked to
    // straddle these two depths.
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 100;

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Front-left RED box. NDC.z ≈ 0.842.
    const frontBox = createBox(engine, 2);
    frontBox.position.set(-1.5, 0, -2);
    const frontMat = createStandardMaterial();
    frontMat.diffuseColor = [0.85, 0.25, 0.25];
    frontBox.material = frontMat;
    addToScene(scene, frontBox);

    // Back-right BLUE box. NDC.z ≈ 0.909.
    const backBox = createBox(engine, 2);
    backBox.position.set(1.5, 0, 2);
    const backMat = createStandardMaterial();
    backMat.diffuseColor = [0.25, 0.4, 0.85];
    backBox.material = backMat;
    addToScene(scene, backBox);

    // One depth-hosted sprite layer holding three sprites at different per-instance Z.
    // No `layerZ` set on the layer — every sprite supplies its own `z`.
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const sprites = createSprite2DLayer(atlas, {
        capacity: 4,
        blendMode: "alpha",
        depth: "test-write",
    });
    const spriteIndices = addPerInstanceZSprites(sprites, canvas);
    let lastLayoutWidth = canvas.width;
    let lastLayoutHeight = canvas.height;
    onBeforeRender(scene, () => {
        if (canvas.width === lastLayoutWidth && canvas.height === lastLayoutHeight) {
            return;
        }
        lastLayoutWidth = canvas.width;
        lastLayoutHeight = canvas.height;
        updatePerInstanceZSprites(sprites, spriteIndices, canvas);
    });
    addDepthHostedSpriteLayer(scene, sprites);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

/** Three side-by-side sprites at canvas centre, each with its own NDC depth.
 *  Sized + positioned so each one overlaps a box and the next sprite. */
function addPerInstanceZSprites(layer: Sprite2DLayer, canvas: HTMLCanvasElement): [number, number, number] {
    const layout = getSpriteLayout(canvas);

    // A — yellow "0", z = 0.6 → in front of both boxes (NDC 0.842 / 0.909).
    const a = addSprite2DIndex(layer, {
        positionPx: layout.a.position,
        sizePx: layout.size,
        frame: 24, // tally digit "0"
        color: [1.0, 0.95, 0.4, 1.0],
        z: 0.6,
    });

    // B — cyan "1", z = 0.87 → between front (0.842) and back (0.909): front
    // box occludes B's left edge; B occludes back box's left edge.
    const b = addSprite2DIndex(layer, {
        positionPx: layout.b.position,
        sizePx: layout.size,
        frame: 25, // tally digit "1"
        color: [0.4, 0.9, 1.0, 1.0],
        z: 0.87,
    });

    // C — magenta "2", z = 0.95 → behind back box (0.909): back box occludes
    // most of C; only C's rightmost slice peeks out past the box silhouette.
    const c = addSprite2DIndex(layer, {
        positionPx: layout.c.position,
        sizePx: layout.size,
        frame: 26, // tally digit "2"
        color: [1.0, 0.5, 0.9, 1.0],
        z: 0.95,
    });

    return [a, b, c];
}

function updatePerInstanceZSprites(layer: Sprite2DLayer, [a, b, c]: readonly [number, number, number], canvas: HTMLCanvasElement): void {
    const layout = getSpriteLayout(canvas);
    updateSprite2DIndex(layer, a, { positionPx: layout.a.position, sizePx: layout.size });
    updateSprite2DIndex(layer, b, { positionPx: layout.b.position, sizePx: layout.size });
    updateSprite2DIndex(layer, c, { positionPx: layout.c.position, sizePx: layout.size });
}

function getSpriteLayout(canvas: HTMLCanvasElement): {
    a: { position: [number, number] };
    b: { position: [number, number] };
    c: { position: [number, number] };
    size: [number, number];
} {
    const scale = canvas.height / DESIGN_HEIGHT;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const size = SPRITE_SIZE * scale;
    const dx = SPRITE_SPACING * scale;
    return {
        a: { position: [cx - dx, cy] },
        b: { position: [cx, cy] },
        c: { position: [cx + dx, cy] },
        size: [size, size],
    };
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
