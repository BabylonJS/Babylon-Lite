// Scene 303: deterministic top-down Sprite2D overlap with stable renderer-native Y-sort.

import {
    addSprite2D,
    addSprite2DIndex,
    createEngine,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createSpriteRenderer,
    createTexture2DFromPixels,
    enableSprite2DYSort,
    getSprite2DHandleIndex,
    pickSprite2D,
    registerSpriteRenderer,
    setSprite2DYSortHandleBias,
    startEngine,
    updateSprite2D,
} from "babylon-lite";

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 96;
const FRAME_COUNT = 6;
const SPRITE_WIDTH = 128;
const SPRITE_HEIGHT = 192;

function writePixel(pixels: Uint8Array, textureWidth: number, x: number, y: number, red: number, green: number, blue: number, alpha: number): void {
    const offset = (y * textureWidth + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alpha;
}

function buildFigureAtlasPixels(): Uint8Array {
    const textureWidth = FRAME_WIDTH * FRAME_COUNT;
    const pixels = new Uint8Array(textureWidth * FRAME_HEIGHT * 4);
    const colors = [
        [45, 190, 210],
        [242, 171, 64],
        [236, 80, 96],
        [166, 102, 232],
        [70, 214, 148],
        [66, 132, 238],
    ] as const;
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
        const color = colors[frame]!;
        const frameOffset = frame * FRAME_WIDTH;
        for (let y = 0; y < FRAME_HEIGHT; y++) {
            for (let x = 0; x < FRAME_WIDTH; x++) {
                const dx = x - 31.5;
                const shadowY = y - 88;
                const shadow = dx * dx * 36 + shadowY * shadowY * 784 <= 784 * 36;
                if (shadow) {
                    writePixel(pixels, textureWidth, frameOffset + x, y, 4, 16, 20, 92);
                }

                const head = dx * dx + (y - 18) * (y - 18) <= 15 * 15;
                const torso = x >= 10 && x <= 53 && y >= 29 && y <= 69;
                const arms = x >= 5 && x <= 58 && y >= 35 && y <= 57;
                const leftLeg = x >= 14 && x <= 29 && y >= 66 && y <= 88;
                const rightLeg = x >= 34 && x <= 49 && y >= 66 && y <= 88;
                if (!head && !torso && !arms && !leftLeg && !rightLeg) {
                    continue;
                }
                writePixel(pixels, textureWidth, frameOffset + x, y, Math.round(color[0] * 0.28), Math.round(color[1] * 0.28), Math.round(color[2] * 0.28), 255);

                const innerHead = dx * dx + (y - 18) * (y - 18) <= 12 * 12;
                const innerTorso = x >= 14 && x <= 49 && y >= 31 && y <= 67;
                const innerArms = x >= 8 && x <= 55 && y >= 38 && y <= 53;
                const innerLeftLeg = x >= 17 && x <= 28 && y >= 65 && y <= 84;
                const innerRightLeg = x >= 35 && x <= 46 && y >= 65 && y <= 84;
                if (innerHead || innerTorso || innerArms || innerLeftLeg || innerRightLeg) {
                    writePixel(pixels, textureWidth, frameOffset + x, y, color[0], color[1], color[2], 255);
                }
                if (y >= 47 && y <= 52 && x >= 27 && x <= 36) {
                    writePixel(pixels, textureWidth, frameOffset + x, y, 238, 244, 224, 255);
                }
                if (y >= 16 && y <= 19 && (x === 27 || x === 36)) {
                    writePixel(pixels, textureWidth, frameOffset + x, y, 8, 20, 24, 255);
                }
            }
        }
    }
    return pixels;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const texture = createTexture2DFromPixels(engine, buildFigureAtlasPixels(), FRAME_WIDTH * FRAME_COUNT, FRAME_HEIGHT, {
        minFilter: "nearest",
        magFilter: "nearest",
    });
    const atlas = createGridSpriteAtlas(texture, {
        cellWidthPx: FRAME_WIDTH,
        cellHeightPx: FRAME_HEIGHT,
        columns: FRAME_COUNT,
        rows: 1,
    });
    const layer = createSprite2DLayer(atlas, {
        capacity: 8,
        depth: "none",
        order: 10,
        pivot: [0.5, 0.86],
    });

    const liveMover = addSprite2D(layer, { positionPx: [400, 260], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 2 });
    const liveBackIndex = addSprite2DIndex(layer, { positionPx: [340, 300], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 0 });
    const firstTie = addSprite2D(layer, { positionPx: [760, 340], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 3 });
    const secondTie = addSprite2D(layer, { positionPx: [810, 340], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 4 });
    const biasedFront = addSprite2D(layer, { positionPx: [1040, 290], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 5 });
    const biasBackIndex = addSprite2DIndex(layer, { positionPx: [980, 320], sizePx: [SPRITE_WIDTH, SPRITE_HEIGHT], frame: 1 });
    const ySort = enableSprite2DYSort(layer);

    const renderer = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.025, g: 0.09, b: 0.085, a: 1 },
    });
    let mutations = 0;
    renderer._beforeUpdate.push(() => {
        if (mutations !== 0) {
            return;
        }
        updateSprite2D(liveMover, { positionPx: [400, 360] });
        setSprite2DYSortHandleBias(biasedFront, 60);
        mutations++;
    });
    registerSpriteRenderer(renderer);
    await startEngine(engine);

    const pickIndex = (x: number, y: number): number => pickSprite2D([layer], x, y)?.spriteIndex ?? -1;
    canvas.dataset.sortEnabled = String(ySort.enabled);
    canvas.dataset.spriteCount = String(layer.count);
    canvas.dataset.liveMoverIndex = String(getSprite2DHandleIndex(liveMover));
    canvas.dataset.liveBackIndex = String(liveBackIndex);
    canvas.dataset.firstTieIndex = String(getSprite2DHandleIndex(firstTie));
    canvas.dataset.secondTieIndex = String(getSprite2DHandleIndex(secondTie));
    canvas.dataset.biasedFrontIndex = String(getSprite2DHandleIndex(biasedFront));
    canvas.dataset.biasBackIndex = String(biasBackIndex);
    canvas.dataset.liveYPick = String(pickIndex(370, 270));
    canvas.dataset.tiePick = String(pickIndex(785, 260));
    canvas.dataset.biasPick = String(pickIndex(1010, 250));
    canvas.dataset.mutations = String(mutations);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.canvasWidth = String(canvas.width);
    canvas.dataset.canvasHeight = String(canvas.height);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
