import { type IVector2Like } from "../../babylonTypes";

import { type BoundingBox } from "../../maths/boundingBox";
import { CreateSpriteNode, type AnimationNode } from "../../nodes/node";
import { ParseNullLayer } from "../../parsing/nullLayer";
import { type Transform, type Vector2Property } from "../../parsing/parsedTypes";
import { GetRasterizationFrame, GetRasterizationScale } from "../../parsing/rasterization";
import { type RawFont, type RawTextData, type RawTextLayer } from "../../parsing/rawTypes";
import { type LottieSpriteRecord } from "../../parsing/spriteRecord";
import {
    addRasterizedSprite,
    getSpritePackerMeasurementContext,
    type SpriteAtlasInfo,
    type SpritePacker,
    type SpritePackerDrawingContext,
    type SpritePackerRasterizationContext,
} from "../../parsing/spritePacker";
import { ApplyLottieTextContext, DrawLottieText, MeasureLottieText, ResolveLottieText } from "./textLayout";

/**
 * Text bounding box data used by the text feature.
 */
export type LottieTextBoundingBox = BoundingBox & {
    /** Distance from the top of the text texture to the first baseline. */
    baselineOffsetY: number;
    /** Descent in pixels of the last text line below its baseline. */
    descent: number;
};

/**
 * Parser dependencies needed by the text layer feature.
 */
export type LottieTextLayerParseContext = {
    /** Raw text layer to parse. */
    layer: RawTextLayer;
    /** Already parsed layer transform. */
    transform: Transform;
    /** Parent node in the animation tree. */
    parent: AnimationNode;
    /** Sprite atlas packer used by this animation. */
    packer: SpritePacker;
    /** Font metadata parsed from the animation. */
    rawFonts: Map<string, RawFont>;
    /** Emits a renderer-agnostic sprite record for later materialization. */
    emitSpriteRecord(record: LottieSpriteRecord): void;
    /** Original Lottie layer index used for render ordering. */
    currentLayerOriginalIndex: number;
    /** Animation start frame, used to choose the rasterization scale for this layer. */
    startFrame: number;
};

/**
 * Text layer feature behavior loaded only for animations that contain visible text layers.
 */
export type LottieTextLayerFeature = {
    /** Parses and rasterizes a Lottie text layer. */
    parseTextLayer(context: LottieTextLayerParseContext): AnimationNode | undefined;
};

/**
 * Text layer feature implementation.
 */
export const TextLayerFeature: LottieTextLayerFeature = {
    parseTextLayer: ParseTextLayer,
};

function ParseTextLayer(context: LottieTextLayerParseContext): AnimationNode | undefined {
    const rasterizationFrame = GetRasterizationFrame(context.layer, context.startFrame);
    const currentScale = GetRasterizationScale(context.parent, rasterizationFrame);
    const spriteInfo = AddLottieTextToAtlas(context.packer, context.layer.t, context.rawFonts, currentScale, context.layer.nm);

    if (spriteInfo === undefined) {
        return undefined;
    }

    const spriteParent = ParseNullLayer(context.layer, context.transform, context.parent);
    const positionProperty = GetTextPosition(spriteInfo);

    const spriteNode = CreateSpriteNode("Sprite", spriteInfo.widthPx, spriteInfo.heightPx, positionProperty, undefined, undefined, undefined, spriteParent);

    context.emitSpriteRecord({
        node: spriteNode,
        atlasIndex: spriteInfo.atlasIndex,
        uOffset: spriteInfo.uOffset,
        vOffset: spriteInfo.vOffset,
        uSize: spriteInfo.cellWidth,
        vSize: spriteInfo.cellHeight,
        width: spriteInfo.widthPx,
        height: spriteInfo.heightPx,
        invertV: true,
        layerOrder: context.currentLayerOriginalIndex,
    });

    return spriteParent;
}

/**
 * Adds a Lottie text document to the sprite atlas.
 * @param packer Sprite atlas packer.
 * @param textData Raw Lottie text data.
 * @param rawFonts Font metadata parsed from the animation.
 * @param scalingFactor Scale to apply to the text rasterization. Mutated with the effective atlas scale.
 * @param debugName Optional layer name for atlas warnings.
 * @returns Sprite atlas information, or undefined when the text cannot be resolved.
 */
export function AddLottieTextToAtlas(
    packer: SpritePacker,
    textData: RawTextData,
    rawFonts: Map<string, RawFont>,
    scalingFactor: IVector2Like,
    debugName?: string
): SpriteAtlasInfo | undefined {
    const boundingBox = GetTextBoundingBox(getSpritePackerMeasurementContext(packer), textData, rawFonts, packer.variables);
    if (boundingBox === undefined) {
        return undefined;
    }

    return addRasterizedSprite(
        packer,
        "text",
        boundingBox,
        scalingFactor,
        (context) => {
            DrawTextToAtlasCell(context, textData, rawFonts, packer.variables, scalingFactor);
        },
        debugName
    );
}

/**
 * Calculates the bounding box for a Lottie text document.
 * @param spritesCanvasContext The 2D context used for text measurement.
 * @param textData The text to calculate the bounding box for.
 * @param rawFonts A map of font names to their raw font data.
 * @param variables A map of variables used by the animation.
 * @returns The bounding box for the text, or undefined when the text cannot be resolved.
 */
export function GetTextBoundingBox(
    spritesCanvasContext: SpritePackerDrawingContext,
    textData: RawTextData,
    rawFonts: Map<string, RawFont>,
    variables: Map<string, string>
): LottieTextBoundingBox | undefined {
    spritesCanvasContext.save();

    const resolvedText = ResolveLottieText(textData, rawFonts, variables);
    if (!resolvedText) {
        spritesCanvasContext.restore();
        return undefined;
    }

    ApplyLottieTextContext(spritesCanvasContext, resolvedText);

    const layout = MeasureLottieText(resolvedText, (text) => spritesCanvasContext.measureText(text));

    spritesCanvasContext.restore();

    return {
        width: layout.width,
        height: layout.height,
        centerX: layout.width / 2,
        centerY: layout.height / 2,
        offsetX: layout.offsetX,
        offsetY: layout.offsetY,
        strokeInset: 0,
        baselineOffsetY: layout.baselineOffsetY,
        descent: layout.descent,
    };
}

function DrawTextToAtlasCell(
    rasterizationContext: SpritePackerRasterizationContext,
    textData: RawTextData,
    rawFonts: Map<string, RawFont>,
    variables: Map<string, string>,
    scalingFactor: IVector2Like
): void {
    const resolvedText = ResolveLottieText(textData, rawFonts, variables);
    if (!resolvedText) {
        return;
    }

    const ctx = rasterizationContext.context;

    ctx.save();
    ctx.translate(rasterizationContext.x, rasterizationContext.y);
    ctx.scale(scalingFactor.x, scalingFactor.y);

    if (resolvedText.textInfo.fc !== undefined) {
        const rawFillStyle = resolvedText.textInfo.fc;
        if (Array.isArray(rawFillStyle)) {
            if (rawFillStyle.length >= 3) {
                ctx.fillStyle = LottieColorToCSSColor(rawFillStyle, 1);
            }
        } else {
            const variableFillStyle = variables.get(rawFillStyle);
            if (variableFillStyle !== undefined) {
                ctx.fillStyle = variableFillStyle;
            }
        }
    }

    if (resolvedText.hasStroke) {
        ctx.strokeStyle = LottieColorToCSSColor(resolvedText.textInfo.sc!, 1);
    }

    ApplyLottieTextContext(ctx, resolvedText);

    const layout = MeasureLottieText(resolvedText, (text) => ctx.measureText(text));

    ctx.beginPath();
    ctx.rect(0, 0, layout.width, layout.height);
    ctx.clip();

    DrawLottieText(ctx, resolvedText, layout);

    ctx.restore();
}

function GetTextPosition(spriteInfo: SpriteAtlasInfo): Vector2Property {
    return {
        startValue: { x: spriteInfo.centerX || 0, y: -spriteInfo.centerY || 0 },
        currentValue: { x: spriteInfo.centerX || 0, y: -spriteInfo.centerY || 0 },
        currentKeyframeIndex: 0,
    };
}

function LottieColorToCSSColor(color: number[], opacity: number): string {
    if (color.length !== 3 && color.length !== 4) {
        return "rgba(0, 0, 0, 1)";
    }

    const r = Math.round(color[0] * 255);
    const g = Math.round(color[1] * 255);
    const b = Math.round(color[2] * 255);
    const a = (color[3] || 1) * opacity;

    return `rgba(${r}, ${g}, ${b}, ${a})`;
}
