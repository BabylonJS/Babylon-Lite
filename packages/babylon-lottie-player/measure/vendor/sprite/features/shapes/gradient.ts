import { type BoundingBox } from "../../maths/boundingBox";
import { GetInitialVectorValues } from "../../parsing/rawPropertyHelpers";
import { type RawElement, type RawGradientFillShape, type RawGradientStrokeShape } from "../../parsing/rawTypes";
import { type SpritePackerDrawingContext } from "../../parsing/spritePacker";
import { type LottieFeature } from "../feature";
import { ApplyStrokeStyle, LottieColorToCSSColor } from "./drawShape";

type DrawingContext = SpritePackerDrawingContext;

/**
 * Information about a gradient stop.
 * Used for gradient fills and strokes when drawing vector shapes into the sprite atlas.
 */
type GradientStop = {
    offset: number;
    color: string;
};

function DrawGradientStroke(stroke: RawGradientStrokeShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    // Build the gradient that will be used as `strokeStyle`. Mirrors `DrawGradientFill` dispatch on `t`
    // (1 = linear, 2 = radial) and reuses the same translation into the bounding box's local space.
    const xTranslate = boundingBox.centerX;
    const yTranslate = boundingBox.centerY;
    // Read initial-frame endpoints so animated gradient endpoints (a===1) build a valid gradient instead
    // of feeding a keyframe array through `as number[]` casts.
    const startPoint = GetInitialVectorValues(stroke.s);
    const endPoint = GetInitialVectorValues(stroke.e);

    let gradient: CanvasGradient | undefined;
    switch (stroke.t) {
        case 1:
            gradient = ctx.createLinearGradient(startPoint[0] + xTranslate, startPoint[1] + yTranslate, endPoint[0] + xTranslate, endPoint[1] + yTranslate);
            break;
        case 2: {
            const centerX = startPoint[0] + xTranslate;
            const centerY = startPoint[1] + yTranslate;
            const outerRadius = Math.hypot(endPoint[0] - startPoint[0], endPoint[1] - startPoint[1]);
            gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, outerRadius);
            break;
        }
    }

    if (gradient === undefined) {
        return;
    }

    // Reuse the shared color-stop builder. `AddColorStops` only reads `g`, which is shared between
    // gradient fills and gradient strokes. Stroke `o` (overall opacity) is intentionally not applied
    // here to match the existing `DrawGradientFill` behavior; if that ever gains opacity support, this
    // method should follow.
    AddColorStops(gradient, stroke);

    ctx.strokeStyle = gradient;
    ApplyStrokeStyle(stroke, ctx);

    ctx.stroke();
}

function DrawGradientFill(fill: RawGradientFillShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    switch (fill.t) {
        case 1: {
            DrawLinearGradientFill(fill, boundingBox, ctx);
            break;
        }
        case 2: {
            DrawRadialGradientFill(fill, boundingBox, ctx);
            break;
        }
    }
}

function DrawLinearGradientFill(fill: RawGradientFillShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    // We need to translate the gradient to the center of the bounding box
    const xTranslate = boundingBox.centerX;
    const yTranslate = boundingBox.centerY;

    // Create the gradient. Use initial-value helpers so animated endpoints (a===1) render their
    // first-frame value into the atlas instead of feeding a keyframe array through `as number[]`.
    const startPoint = GetInitialVectorValues(fill.s);
    const endPoint = GetInitialVectorValues(fill.e);
    const gradient = ctx.createLinearGradient(startPoint[0] + xTranslate, startPoint[1] + yTranslate, endPoint[0] + xTranslate, endPoint[1] + yTranslate);

    AddColorStops(gradient, fill);

    ctx.fillStyle = gradient;
    ctx.fill();
}

function DrawRadialGradientFill(fill: RawGradientFillShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    // We need to translate the gradient to the center of the bounding box
    const xTranslate = boundingBox.centerX;
    const yTranslate = boundingBox.centerY;

    // Create the gradient. Use initial-value helpers so animated endpoints (a===1) render their
    // first-frame value into the atlas instead of feeding a keyframe array through `as number[]`.
    const startPoint = GetInitialVectorValues(fill.s);
    const endPoint = GetInitialVectorValues(fill.e);

    const centerX = startPoint[0] + xTranslate;
    const centerY = startPoint[1] + yTranslate;
    const outerRadius = Math.hypot(endPoint[0] - startPoint[0], endPoint[1] - startPoint[1]);
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, outerRadius);

    AddColorStops(gradient, fill);

    ctx.fillStyle = gradient;
    ctx.fill();
}

function AddColorStops(gradient: CanvasGradient, fill: RawGradientFillShape | RawGradientStrokeShape): void {
    const stops = fill.g.p;
    const rawColors = fill.g.k.k;

    let stopsData: GradientStop[] | undefined;
    if (rawColors.length / stops === 4) {
        // Offset + RGB
        stopsData = GradientColorsToCssColor(rawColors, stops, false);
    } else if (rawColors.length / stops === 6) {
        // Offset + RGB + Offset + Alpha
        stopsData = GradientColorsToCssColor(rawColors, stops, true);
    } else {
        return;
    }

    for (let i = 0; i < stops; i++) {
        gradient.addColorStop(stopsData[i].offset, stopsData[i].color);
    }
}

function GradientColorsToCssColor(colors: number[], stops: number, hasAlpha: boolean): GradientStop[] {
    const result: GradientStop[] = [];
    for (let i = 0; i < stops; i++) {
        const index = i * 4;
        result.push({
            offset: colors[index],
            color: LottieColorToCSSColor(colors.slice(index + 1, index + 4), hasAlpha ? colors[stops * 4 + i * 2 + 1] : 1),
        });
    }

    return result;
}

function DrawGradientItem(shape: RawElement, boundingBox: BoundingBox, ctx: DrawingContext): void {
    if (shape.ty === "gf") {
        DrawGradientFill(shape as RawGradientFillShape, boundingBox, ctx);
    } else if (shape.ty === "gs") {
        DrawGradientStroke(shape as RawGradientStrokeShape, boundingBox, ctx);
    }
}

/**
 * Gradient draw sub-feature. Loaded only for animations that paint gradient fills (`gf`) or gradient
 * strokes (`gs`), so the gradient machinery is never downloaded by gradient-free animations.
 */
const GradientShapeFeature = {
    id: "shape-gradient",
    shapeDrawer: {
        types: ["gf", "gs"],
        draw: DrawGradientItem,
    },
} as const satisfies LottieFeature;

export default GradientShapeFeature;
