import { type GLEngineContext, type GLTexture } from "babylon-lite-gl";
import { createDynamicTexture, updateDynamicTexture } from "babylon-lite-gl/dynamic-texture";

import { type IVector2Like } from "../babylonTypes";
import { type BoundingBox } from "../maths/boundingBox";

import { type LottieRendererConfig } from "../animationConfiguration";

/**
 * Type alias for the 2D drawing context used by the sprite packer.
 */
export type SpritePackerDrawingContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * Canvas context and atlas cell placement for a sprite rasterization callback.
 */
export type SpritePackerRasterizationContext = {
    /** Atlas page drawing context. */
    context: SpritePackerDrawingContext;
    /** X coordinate of the allocated atlas cell in pixels. */
    x: number;
    /** Y coordinate of the allocated atlas cell in pixels. */
    y: number;
    /** Width of the allocated atlas cell in pixels. */
    cellWidth: number;
    /** Height of the allocated atlas cell in pixels. */
    cellHeight: number;
};

/**
 * Information about a sprite in the sprite atlas.
 */
export type SpriteAtlasInfo = {
    /**
     * Offset in the x axis of the sprite in the atlas.
     * Normalized between 0 and 1, left to right.
     */
    uOffset: number;
    /**
     * Offset in the y axis of the sprite in the atlas.
     * Normalized between 0 and 1, top to bottom.
     */
    vOffset: number;

    /**
     * Width of the sprite in the atlas.
     * In pixels.
     */
    cellWidth: number;

    /**
     * Height of the sprite in the atlas.
     * In pixels.
     */
    cellHeight: number;

    /**
     * Width of the sprite in the screen.
     * In pixels.
     */
    widthPx: number;
    /**
     * Height of the sprite in the screen.
     * In pixels.
     */
    heightPx: number;

    /**
     * X coordinate of the center of the sprite bounding box, used for final positioning in the screen
     */
    centerX: number;

    /**
     * Y coordinate of the center of the sprite bounding box, used for final positioning in the screen
     */
    centerY: number;

    /**
     * Index of the atlas page this sprite belongs to.
     * Used when the animation has more sprites than fit in a single atlas texture.
     */
    atlasIndex: number;
};

/**
 * Represents a single page in the sprite atlas. When sprites exceed the capacity of one
 * texture, additional pages are created automatically.
 */
type AtlasPage = {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    texture: GLTexture;
    isDirty: boolean;
    currentX: number;
    currentY: number;
    maxRowHeight: number;
};

/**
 * Packs sprites into one or more texture atlas pages. If sprites exceed the capacity of a single
 * atlas texture, additional atlas pages are created automatically. This is plain state operated on
 * by the functions below — there is no instance behavior.
 */
export type SpritePacker = {
    /** Engine that will render the sprites. */
    engine: GLEngineContext;
    /** Whether the atlas is rasterized in an HTMLCanvasElement (true) or an OffscreenCanvas (false). */
    isHtmlCanvas: boolean;
    /** The atlas scale factor applied to the sprites (always >= 1 to keep sprites crisp). */
    atlasScale: number;
    /** Map of variables used by feature-owned rasterizers. */
    variables: Map<string, string>;
    /** Renderer-bound configuration for atlas and raster settings. */
    rendererConfiguration: LottieRendererConfig;
    /** All atlas pages, in creation order. */
    pages: AtlasPage[];
    /** Reused result object to avoid per-sprite allocations. */
    spriteAtlasInfo: SpriteAtlasInfo;
};

/**
 * Creates a new sprite packer with a single initial atlas page.
 * @param engine Engine that will render the sprites.
 * @param isHtmlCanvas Whether we should render the atlas in an HTMLCanvasElement or an OffscreenCanvas.
 * @param atlasScale The atlas scale factor to apply to the sprites (always \>= 1 to keep sprites crisp).
 * @param variables Map of variables to replace in the animation file.
 * @param rendererConfiguration Renderer-bound configuration for atlas and raster settings.
 * @returns The new sprite packer state.
 */
export function createSpritePacker(
    engine: GLEngineContext,
    isHtmlCanvas: boolean,
    atlasScale: number,
    variables: Map<string, string>,
    rendererConfiguration: LottieRendererConfig
): SpritePacker {
    const packer: SpritePacker = {
        engine,
        isHtmlCanvas,
        atlasScale,
        variables,
        rendererConfiguration,
        pages: [],
        spriteAtlasInfo: {
            uOffset: 0,
            vOffset: 0,
            cellWidth: 0,
            cellHeight: 0,
            widthPx: 0,
            heightPx: 0,
            centerX: 0,
            centerY: 0,
            atlasIndex: 0,
        },
    };

    packer.pages.push(CreatePage(packer));

    return packer;
}

/**
 * Gets the textures for all atlas pages.
 * @param packer The sprite packer.
 * @returns An array of textures, one per atlas page.
 */
export function getSpritePackerTextures(packer: SpritePacker): GLTexture[] {
    return packer.pages.map((p) => p.texture);
}

/**
 * Gets a canvas context that feature-owned rasterizers can use for measurement before allocation.
 * @param packer The sprite packer.
 * @returns The current atlas page drawing context.
 */
export function getSpritePackerMeasurementContext(packer: SpritePacker): SpritePackerDrawingContext {
    return packer.pages[packer.pages.length - 1].context;
}

/**
 * Adds a feature-owned rasterized sprite to the atlas.
 * @param packer The sprite packer.
 * @param kind Kind of sprite being rasterized, used for diagnostics.
 * @param boundingBox Source bounding box in lottie coordinates, before any scaling.
 * @param scalingFactor The scaling factor to apply while drawing into the atlas. Mutated with the effective atlas scale.
 * @param drawSprite Callback that draws into the allocated atlas cell.
 * @param debugName Optional human-readable identifier (e.g. owning layer name) included in oversize warnings.
 * @returns The information on how to find the sprite in the atlas.
 */
export function addRasterizedSprite(
    packer: SpritePacker,
    kind: "shape" | "text" | "solid",
    boundingBox: BoundingBox,
    scalingFactor: IVector2Like,
    drawSprite: (context: SpritePackerRasterizationContext) => void,
    debugName?: string
): SpriteAtlasInfo {
    const config = packer.rendererConfiguration;
    const info = packer.spriteAtlasInfo;

    const layerScaleX = scalingFactor.x;
    const layerScaleY = scalingFactor.y;
    ApplyAtlasScaleAndFit(packer, kind, debugName, boundingBox, scalingFactor, layerScaleX, layerScaleY);

    // Calculate the size of the sprite in the atlas in pixels
    // This takes into account the scaling factor so in the draw callback the canvas will be scaled when rendering
    info.cellWidth = GetAtlasCellDimension(boundingBox.width * scalingFactor.x);
    info.cellHeight = GetAtlasCellDimension(boundingBox.height * scalingFactor.y);

    // Get (or create) the page that has room for this sprite
    const page = GetPageWithRoom(packer, info.cellWidth, info.cellHeight);

    // Draw the sprite in the canvas
    drawSprite({ context: page.context, x: page.currentX, y: page.currentY, cellWidth: info.cellWidth, cellHeight: info.cellHeight });
    ExtrudeSpriteEdges(packer, page, page.currentX, page.currentY, info.cellWidth, info.cellHeight);
    page.isDirty = true;

    // Get the rest of the sprite information required to render the shape
    info.uOffset = page.currentX / config.spriteAtlasWidth;
    info.vOffset = page.currentY / config.spriteAtlasHeight;

    info.widthPx = boundingBox.width;
    info.heightPx = boundingBox.height;

    info.centerX = boundingBox.offsetX;
    info.centerY = boundingBox.offsetY;

    info.atlasIndex = packer.pages.indexOf(page);

    // Advance the current position for the next sprite
    page.currentX += info.cellWidth + config.gapSize; // Add a gap between sprites to avoid bleeding
    page.maxRowHeight = Math.max(page.maxRowHeight, info.cellHeight);

    return info;
}

/**
 * Updates all dirty atlas page textures with the latest canvas content.
 * @param packer The sprite packer.
 */
export function updateAtlasTexture(packer: SpritePacker): void {
    for (const page of packer.pages) {
        if (!page.isDirty) {
            continue;
        }
        updateDynamicTexture(packer.engine, page.texture, page.canvas, false, false);
        page.isDirty = false;
    }
}

/**
 * Releases the canvases and their contexts to allow garbage collection.
 * @param packer The sprite packer.
 */
export function releaseSpritePackerCanvas(packer: SpritePacker): void {
    for (const page of packer.pages) {
        page.context = undefined as any;
        page.canvas = undefined as any;
    }
}

function CreatePage(packer: SpritePacker): AtlasPage {
    const config = packer.rendererConfiguration;

    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

    if (packer.isHtmlCanvas) {
        canvas = document.createElement("canvas");
        canvas.width = config.spriteAtlasWidth;
        canvas.height = config.spriteAtlasHeight;
        context = canvas.getContext("2d") as CanvasRenderingContext2D;
    } else {
        canvas = new OffscreenCanvas(config.spriteAtlasWidth, config.spriteAtlasHeight);
        context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    }

    // lite-gl dynamic-texture defaults (LINEAR min/mag, CLAMP_TO_EDGE wrap, no mipmaps) match the
    // old `createDynamicTexture(w, h, false, BILINEAR)` + `wrapU/wrapV = CLAMP` configuration.
    const texture = createDynamicTexture(packer.engine, config.spriteAtlasWidth, config.spriteAtlasHeight);
    updateDynamicTexture(packer.engine, texture, canvas, false, false);

    return {
        canvas,
        context,
        texture,
        isDirty: false,
        currentX: config.gapSize,
        currentY: config.gapSize,
        maxRowHeight: 0,
    };
}

/**
 * Returns a page with room for a sprite of the given size. Wraps to the next row if needed,
 * and creates a new page if the current page is full.
 * @param packer The sprite packer.
 * @param cellWidth The width of the sprite cell in pixels.
 * @param cellHeight The height of the sprite cell in pixels.
 * @returns An atlas page with enough room for the sprite.
 */
function GetPageWithRoom(packer: SpritePacker, cellWidth: number, cellHeight: number): AtlasPage {
    const config = packer.rendererConfiguration;
    let page = packer.pages[packer.pages.length - 1];

    // Defensive clamp: ApplyAtlasScaleAndFit should have already downscaled oversized cells
    // to fit on a single page. This handles the rounding edge case where ceil() pushes a cell
    // a single pixel past the limit.
    const maxCellWidth = config.spriteAtlasWidth - 2 * config.gapSize;
    const maxCellHeight = config.spriteAtlasHeight - 2 * config.gapSize;
    if (cellWidth > maxCellWidth || cellHeight > maxCellHeight) {
        packer.spriteAtlasInfo.cellWidth = Math.min(cellWidth, maxCellWidth);
        packer.spriteAtlasInfo.cellHeight = Math.min(cellHeight, maxCellHeight);
        cellWidth = packer.spriteAtlasInfo.cellWidth;
        cellHeight = packer.spriteAtlasInfo.cellHeight;
    }

    // Check if the sprite fits in the current row
    if (page.currentX + cellWidth > config.spriteAtlasWidth) {
        // Move to the next row
        page.currentX = config.gapSize;
        page.currentY += page.maxRowHeight + config.gapSize;
        page.maxRowHeight = 0;
    }

    // Check if the sprite fits vertically on this page
    if (page.currentY + cellHeight > config.spriteAtlasHeight) {
        // Current page is full — create a new one
        page = CreatePage(packer);
        packer.pages.push(page);
    }

    return page;
}

function GetAtlasCellDimension(size: number): number {
    return Math.max(1, Math.ceil(size));
}

/**
 * Combines the layer-side scale with the global atlas scale and devicePixelRatio, then
 * automatically downscales the result if the rasterized cell would not fit on a single
 * atlas page. The on-screen size of the sprite is unaffected (it is sourced from the raw
 * lottie bounding box), only the atlas resolution of this particular sprite is reduced.
 *
 * Mutates `scalingFactor` in place with the final effective scale to use when drawing
 * into the atlas canvas. When a downscale is applied, emits a warning that identifies the
 * offending layer and the scale factors involved so the source can be diagnosed.
 * @param packer The sprite packer.
 * @param kind Kind of sprite being rasterized, used for diagnostics.
 * @param debugName Optional human-readable identifier (typically the owning layer name).
 * @param boundingBox Source bounding box in lottie coordinates, before any scaling.
 * @param scalingFactor Layer-side scale on input; receives the final effective scale on output.
 * @param layerScaleX Original layer-side X scale (preserved for the warning message).
 * @param layerScaleY Original layer-side Y scale (preserved for the warning message).
 */
function ApplyAtlasScaleAndFit(
    packer: SpritePacker,
    kind: "shape" | "text" | "solid",
    debugName: string | undefined,
    boundingBox: BoundingBox,
    scalingFactor: IVector2Like,
    layerScaleX: number,
    layerScaleY: number
): void {
    const config = packer.rendererConfiguration;
    const atlasW = config.spriteAtlasWidth;
    const atlasH = config.spriteAtlasHeight;
    const maxCellWidth = atlasW - 2 * config.gapSize;
    const maxCellHeight = atlasH - 2 * config.gapSize;

    let effectiveScaleX = scalingFactor.x * packer.atlasScale * config.devicePixelRatio;
    let effectiveScaleY = scalingFactor.y * packer.atlasScale * config.devicePixelRatio;

    const projectedWidth = boundingBox.width * effectiveScaleX;
    const projectedHeight = boundingBox.height * effectiveScaleY;

    // Auto-fit: if the projected cell exceeds an atlas page on either axis, scale uniformly
    // down by the worst-axis ratio so the sprite still fits at the highest resolution we can
    // afford. Uniform scaling preserves the sprite's aspect ratio in the atlas.
    // Use the ceiled projected dimensions so that after the caller re-applies Math.ceil to
    // size the cell, the result is provably <= maxCellWidth/maxCellHeight and the defensive
    // clamp in GetPageWithRoom is not triggered by sub-pixel rounding.
    const ceiledProjectedWidth = projectedWidth > 0 ? Math.ceil(projectedWidth) : 0;
    const ceiledProjectedHeight = projectedHeight > 0 ? Math.ceil(projectedHeight) : 0;
    const fitScale = Math.min(1, ceiledProjectedWidth > 0 ? maxCellWidth / ceiledProjectedWidth : 1, ceiledProjectedHeight > 0 ? maxCellHeight / ceiledProjectedHeight : 1);

    if (fitScale < 1) {
        effectiveScaleX *= fitScale;
        effectiveScaleY *= fitScale;

        const dpr = config.devicePixelRatio;
        const atlasScale = packer.atlasScale;
        const rawW = boundingBox.width.toFixed(2);
        const rawH = boundingBox.height.toFixed(2);
        const lsx = layerScaleX.toFixed(3);
        const lsy = layerScaleY.toFixed(3);
        const name = debugName ?? "<unknown>";
        const finalW = Math.max(1, Math.ceil(boundingBox.width * effectiveScaleX));
        const finalH = Math.max(1, Math.ceil(boundingBox.height * effectiveScaleY));
        const gap = config.gapSize;

        console.warn(
            `[SpritePacker] ${kind} sprite for layer "${name}" would produce a ${ceiledProjectedWidth}x${ceiledProjectedHeight}px cell that exceeds the usable ${maxCellWidth}x${maxCellHeight}px atlas area ` +
                `(within a ${atlasW}x${atlasH}px page with ${gap}px reserved on each side). ` +
                `Auto-downscaled by ${fitScale.toFixed(3)} to ${finalW}x${finalH}px (on-screen size unchanged; sprite will appear softer than the rest of the atlas). ` +
                `Source bounding box: ${rawW}x${rawH}px at lottie scale ${lsx}x${lsy} \u00d7 atlasScale ${atlasScale} \u00d7 devicePixelRatio ${dpr}.`
        );
    }

    scalingFactor.x = effectiveScaleX;
    scalingFactor.y = effectiveScaleY;
}

function ExtrudeSpriteEdges(packer: SpritePacker, page: AtlasPage, x: number, y: number, width: number, height: number): void {
    const config = packer.rendererConfiguration;
    const padding = Math.min(2, Math.floor(config.gapSize / 2));
    const pixelX = Math.floor(x);
    const pixelY = Math.floor(y);
    const pixelWidth = Math.ceil(width);
    const pixelHeight = Math.ceil(height);

    if (padding <= 0 || pixelWidth <= 0 || pixelHeight <= 0) {
        return;
    }

    for (let offset = 1; offset <= padding; offset++) {
        // Left edge
        if (pixelX - offset >= 0) {
            page.context.drawImage(page.canvas, pixelX, pixelY, 1, pixelHeight, pixelX - offset, pixelY, 1, pixelHeight);
        }

        // Right edge
        if (pixelX + pixelWidth - 1 + offset < config.spriteAtlasWidth) {
            page.context.drawImage(page.canvas, pixelX + pixelWidth - 1, pixelY, 1, pixelHeight, pixelX + pixelWidth - 1 + offset, pixelY, 1, pixelHeight);
        }

        // Top edge
        if (pixelY - offset >= 0) {
            page.context.drawImage(page.canvas, pixelX, pixelY, pixelWidth, 1, pixelX, pixelY - offset, pixelWidth, 1);
        }

        // Bottom edge
        if (pixelY + pixelHeight - 1 + offset < config.spriteAtlasHeight) {
            page.context.drawImage(page.canvas, pixelX, pixelY + pixelHeight - 1, pixelWidth, 1, pixelX, pixelY + pixelHeight - 1 + offset, pixelWidth, 1);
        }

        // Top-left corner
        if (pixelX - offset >= 0 && pixelY - offset >= 0) {
            page.context.drawImage(page.canvas, pixelX, pixelY, 1, 1, pixelX - offset, pixelY - offset, 1, 1);
        }

        // Top-right corner
        if (pixelX + pixelWidth - 1 + offset < config.spriteAtlasWidth && pixelY - offset >= 0) {
            page.context.drawImage(page.canvas, pixelX + pixelWidth - 1, pixelY, 1, 1, pixelX + pixelWidth - 1 + offset, pixelY - offset, 1, 1);
        }

        // Bottom-left corner
        if (pixelX - offset >= 0 && pixelY + pixelHeight - 1 + offset < config.spriteAtlasHeight) {
            page.context.drawImage(page.canvas, pixelX, pixelY + pixelHeight - 1, 1, 1, pixelX - offset, pixelY + pixelHeight - 1 + offset, 1, 1);
        }

        // Bottom-right corner
        if (pixelX + pixelWidth - 1 + offset < config.spriteAtlasWidth && pixelY + pixelHeight - 1 + offset < config.spriteAtlasHeight) {
            page.context.drawImage(page.canvas, pixelX + pixelWidth - 1, pixelY + pixelHeight - 1, 1, 1, pixelX + pixelWidth - 1 + offset, pixelY + pixelHeight - 1 + offset, 1, 1);
        }
    }
}
