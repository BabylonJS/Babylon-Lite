import { type LottieRendererConfig } from "../../animationConfiguration";
import { type BoundingBox } from "../../maths/boundingBox";
import { CreateSpriteNode, type AnimationNode } from "../../nodes/node";
import { ParseNullLayer } from "../../parsing/nullLayer";
import { type Vector2Property, type Transform } from "../../parsing/parsedTypes";
import { type RawSolidLayer } from "../../parsing/rawTypes";
import { type LottieSpriteRecord } from "../../parsing/spriteRecord";
import { addRasterizedSprite, type SpriteAtlasInfo, type SpritePacker, type SpritePackerRasterizationContext } from "../../parsing/spritePacker";

const SolidAtlasBoundingBox: BoundingBox = {
    width: 1,
    height: 1,
    centerX: 0.5,
    centerY: 0.5,
    offsetX: 0.5,
    offsetY: 0.5,
    strokeInset: 0,
};

/**
 * Parser dependencies needed by the solid layer feature.
 */
export type LottieSolidLayerParseContext = {
    /** Raw solid layer to parse. */
    layer: RawSolidLayer;
    /** Already parsed layer transform. */
    transform: Transform;
    /** Parent node in the animation tree. */
    parent: AnimationNode;
    /** Sprite atlas packer used by this animation. */
    packer: SpritePacker;
    /** Renderer-bound configuration needed for center-UV sampling. */
    rendererConfiguration: LottieRendererConfig;
    /** Emits a renderer-agnostic sprite record for later materialization. */
    emitSpriteRecord(record: LottieSpriteRecord): void;
    /** Original Lottie layer index used for render ordering. */
    currentLayerOriginalIndex: number;
};

/**
 * Solid layer feature behavior loaded only when visible solid layers render in spec mode.
 */
export type LottieSolidLayerFeature = {
    /** Parses and rasterizes a Lottie solid layer. */
    parseSolidLayer(context: LottieSolidLayerParseContext): AnimationNode;
};

/**
 * Solid layer feature implementation.
 */
export const SolidLayerFeature: LottieSolidLayerFeature = {
    parseSolidLayer: ParseSolidLayer,
};

function ParseSolidLayer(context: LottieSolidLayerParseContext): AnimationNode {
    const anchorNode = ParseNullLayer(context.layer, context.transform, context.parent);

    if (!(context.layer.sw > 0) || !(context.layer.sh > 0)) {
        return anchorNode;
    }

    const color = ParseCssColorString(context.layer.sc);
    const spriteInfo = AddSolidToAtlas(context.packer, color, context.layer.nm);

    // Center-UV sampling preserves the solid-layer fix from 89da7c8994 (after #18402): sample the
    // middle of the 1x1 atlas cell so edge extrusion/gap pixels cannot bleed into stretched solids.
    const uOffset = spriteInfo.uOffset + spriteInfo.cellWidth / (2 * context.rendererConfiguration.spriteAtlasWidth);
    const vOffset = spriteInfo.vOffset + spriteInfo.cellHeight / (2 * context.rendererConfiguration.spriteAtlasHeight);

    const positionProperty: Vector2Property = {
        startValue: { x: context.layer.sw / 2, y: -context.layer.sh / 2 },
        currentValue: { x: context.layer.sw / 2, y: -context.layer.sh / 2 },
        currentKeyframeIndex: 0,
    };

    const spriteNode = CreateSpriteNode("Sprite", context.layer.sw, context.layer.sh, positionProperty, undefined, undefined, undefined, anchorNode);

    context.emitSpriteRecord({
        node: spriteNode,
        atlasIndex: spriteInfo.atlasIndex,
        uOffset,
        vOffset,
        uSize: 0,
        vSize: 0,
        width: context.layer.sw,
        height: context.layer.sh,
        invertV: true,
        layerOrder: context.currentLayerOriginalIndex,
    });

    return anchorNode;
}

function AddSolidToAtlas(packer: SpritePacker, color: [number, number, number], debugName?: string): SpriteAtlasInfo {
    const atlasScale = { x: 1, y: 1 };
    return addRasterizedSprite(packer, "solid", SolidAtlasBoundingBox, atlasScale, (context) => DrawSolidAtlasCell(context, color), debugName);
}

function DrawSolidAtlasCell(rasterizationContext: SpritePackerRasterizationContext, color: [number, number, number]): void {
    const ctx = rasterizationContext.context;
    ctx.save();
    ctx.fillStyle = LottieColorToCSSColor(color, 1);
    ctx.fillRect(rasterizationContext.x, rasterizationContext.y, rasterizationContext.cellWidth, rasterizationContext.cellHeight);
    ctx.restore();
}

function ParseCssColorString(value: string): [number, number, number] {
    if (typeof value === "string") {
        if (value.length === 7 && value[0] === "#") {
            const r = parseInt(value.substring(1, 3), 16);
            const g = parseInt(value.substring(3, 5), 16);
            const b = parseInt(value.substring(5, 7), 16);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                return [r / 255, g / 255, b / 255];
            }
        }
        if (value.length === 4 && value[0] === "#") {
            const r = parseInt(value[1] + value[1], 16);
            const g = parseInt(value[2] + value[2], 16);
            const b = parseInt(value[3] + value[3], 16);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                return [r / 255, g / 255, b / 255];
            }
        }
    }

    return [1, 1, 1];
}

function LottieColorToCSSColor(color: [number, number, number], opacity: number): string {
    const r = Math.round(color[0] * 255);
    const g = Math.round(color[1] * 255);
    const b = Math.round(color[2] * 255);

    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
