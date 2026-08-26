import { AttachSprite, type LottieSprite } from "../nodes/node";
import { type LottieSpriteRecord } from "../parsing/spriteRecord";
import { type SpritePacker, getSpritePackerTextures } from "../parsing/spritePacker";
import { type RenderingManager, addSprite, prepareRenderingManager } from "./renderingManager";

/**
 * Translates renderer-agnostic {@link LottieSpriteRecord}s produced by parsing into lite-gl
 * `GLSprite`s, attaches each sprite to its scene-graph node, registers it for rendering, and
 * finalizes the rendering manager. This adapter is the only place that knows about the lite-gl
 * sprite API; replacing the rendering backend means replacing this module, not the parser or
 * feature modules.
 * @param records Sprite records emitted during parsing, in creation order.
 * @param packer Sprite atlas packer holding the finalized atlas page textures.
 * @param renderingManager Rendering manager that batches and draws the sprites.
 */
export function MaterializeSpriteRecords(records: readonly LottieSpriteRecord[], packer: SpritePacker, renderingManager: RenderingManager): void {
    for (let i = 0; i < records.length; i++) {
        const record = records[i];

        // Manual-UV rect (presence of `uSize` makes lite-gl ignore the cellIndex grid), mirroring
        // the old ThinSprite `_xOffset/_yOffset/_xSize/_ySize` lottie-atlas addressing. `color` is
        // always present so the per-frame opacity push in UpdateNode (sprite.color.a = ...) has a target.
        const sprite: LottieSprite = {
            position: { x: 0, y: 0, z: 0 },
            width: record.width,
            height: record.height,
            angle: 0,
            uOffset: record.uOffset,
            vOffset: record.vOffset,
            uSize: record.uSize,
            vSize: record.vSize,
            invertV: record.invertV,
            color: { r: 1, g: 1, b: 1, a: 1 },
        };

        AttachSprite(record.node, sprite);
        addSprite(renderingManager, sprite, record.layerOrder, record.atlasIndex);
    }

    // Sprites are registered; finalize the renderer with the packed atlas textures.
    prepareRenderingManager(renderingManager, getSpritePackerTextures(packer));
}
