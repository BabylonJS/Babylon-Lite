import { addSprite2DIndex, type Sprite2DLayer } from "babylon-lite";

export interface SpriteGridOptions {
    columns?: number;
    rows?: number;
    cellPx?: number;
    frameForIndex: (index: number) => number;
}

export function addDeterministicSpriteGrid(layer: Sprite2DLayer, canvas: HTMLCanvasElement, options: SpriteGridOptions): void {
    const columns = options.columns ?? 25;
    const rows = options.rows ?? 10;
    const cellPx = options.cellPx ?? 40;
    const gridWidthPx = columns * cellPx;
    const gridHeightPx = rows * cellPx;
    const originX = (canvas.width - gridWidthPx) / 2 + cellPx / 2;
    const originY = (canvas.height - gridHeightPx) / 2 + cellPx / 2;

    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const index = row * columns + column;
            addSprite2DIndex(layer, {
                positionPx: [originX + column * cellPx, originY + row * cellPx],
                sizePx: index % 11 === 0 ? [40, 40] : [28, 28],
                frame: options.frameForIndex(index),
                color: getGridTint(index),
                rotation: index % 5 === 0 ? Math.PI / 6 : 0,
                flipX: index % 7 === 0,
            });
        }
    }
}

function getGridTint(index: number): [number, number, number, number] {
    const tintIndex = index % 3;
    if (tintIndex === 0) {
        return [1, 1, 1, 1];
    }
    return tintIndex === 1 ? [1, 0.7, 0.7, 1] : [0.7, 1, 0.85, 1];
}
