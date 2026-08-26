import { type IVector2Like } from "../../babylonTypes";

import { type BoundingBox } from "../../maths/boundingBox";
import { GetInitialBezierData, GetInitialColorValue, GetInitialScalarValue, GetInitialVectorValues } from "../../parsing/rawPropertyHelpers";
import {
    type RawElement,
    type RawEllipseShape,
    type RawFillShape,
    type RawGradientStrokeShape,
    type RawPathShape,
    type RawRectangleShape,
    type RawStrokeShape,
} from "../../parsing/rawTypes";
import { type SpritePackerDrawingContext, type SpritePackerRasterizationContext } from "../../parsing/spritePacker";
import { type ShapeDrawFn } from "./shapeDrawer";

type DrawingContext = SpritePackerDrawingContext;

/**
 * Rasterizes a Lottie vector shape into an allocated atlas cell using the Canvas2D API.
 * Shape items whose `ty` is present in `drawers` are dispatched to the injected drawer (loaded as a
 * sub-feature, e.g. gradients); the remaining built-in items are drawn inline. This keeps drawing
 * code for optional items (gradients) out of the base shape chunk so it is only downloaded when used.
 * @param rawElements The raw elements (paths, shapes, fills, strokes) that make up the shape.
 * @param boundingBox The shape bounding box in lottie coordinates.
 * @param scalingFactor The effective atlas scale to apply while drawing.
 * @param rasterizationContext The atlas page drawing context and allocated cell placement.
 * @param drawers Optional injected drawers for sub-feature shape items, keyed by shape `ty`.
 */
export function DrawVectorShape(
    rawElements: RawElement[],
    boundingBox: BoundingBox,
    scalingFactor: IVector2Like,
    rasterizationContext: SpritePackerRasterizationContext,
    drawers?: ReadonlyMap<string, ShapeDrawFn>
): void {
    const ctx = rasterizationContext.context;

    ctx.save();
    ctx.globalCompositeOperation = "destination-over";

    ctx.translate(rasterizationContext.x + Math.ceil(boundingBox.strokeInset / 2), rasterizationContext.y + Math.ceil(boundingBox.strokeInset / 2));
    ctx.scale(scalingFactor.x, scalingFactor.y);

    ctx.beginPath();
    ctx.rect(0, 0, boundingBox.width, boundingBox.height);
    ctx.clip();
    ctx.beginPath();

    for (let i = 0; i < rawElements.length; i++) {
        const shape = rawElements[i];

        // Sub-feature shape items (e.g. gradients) are handled by drawers loaded only when detected.
        const injected = drawers?.get(shape.ty);
        if (injected !== undefined) {
            injected(shape, boundingBox, ctx);
            continue;
        }

        switch (shape.ty) {
            case "rc":
                DrawRectangle(shape as RawRectangleShape, boundingBox, ctx);
                break;
            case "el":
                DrawEllipse(shape as RawEllipseShape, boundingBox, ctx);
                break;
            case "sh":
                DrawPath(shape as RawPathShape, boundingBox, ctx);
                break;
            case "fl":
                DrawFill(shape as RawFillShape, ctx);
                break;
            case "st":
                DrawStroke(shape as RawStrokeShape, ctx);
                break;
            case "tr":
                break; // Nothing needed with transforms
            default:
                break;
        }
    }

    ctx.restore();
}

function DrawRectangle(shape: RawRectangleShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    const size = GetInitialVectorValues(shape.s);
    const position = GetInitialVectorValues(shape.p);
    const radius = GetInitialScalarValue(shape.r);

    // Translate to the correct position within the atlas cell, same as paths use centerX/centerY
    const x = position[0] - size[0] / 2 + boundingBox.centerX - Math.ceil(boundingBox.strokeInset);
    const y = position[1] - size[1] / 2 + boundingBox.centerY - Math.ceil(boundingBox.strokeInset);

    if (radius <= 0) {
        ctx.rect(x, y, size[0], size[1]);
    } else {
        ctx.roundRect(x, y, size[0], size[1], radius);
    }
}

function DrawEllipse(shape: RawEllipseShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    const size = GetInitialVectorValues(shape.s);
    const position = GetInitialVectorValues(shape.p);

    const centerX = position[0] + boundingBox.centerX - Math.ceil(boundingBox.strokeInset);
    const centerY = position[1] + boundingBox.centerY - Math.ceil(boundingBox.strokeInset);
    const radiusX = size[0] / 2;
    const radiusY = size[1] / 2;

    ctx.moveTo(centerX + radiusX, centerY);
    ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
}

function DrawPath(shape: RawPathShape, boundingBox: BoundingBox, ctx: DrawingContext): void {
    // The path data has to be translated to the center of the bounding box
    // If the paths have stroke, we need to account for the stroke width
    const pathData = GetInitialBezierData(shape.ks);
    if (!pathData) {
        return;
    }
    const xTranslate = boundingBox.centerX - Math.ceil(boundingBox.strokeInset);
    const yTranslate = boundingBox.centerY - Math.ceil(boundingBox.strokeInset);

    const vertices = pathData.v;
    const inTangents = pathData.i;
    const outTangents = pathData.o;

    if (vertices.length > 0) {
        ctx.moveTo(vertices[0][0] + xTranslate, vertices[0][1] + yTranslate);

        for (let i = 0; i < vertices.length - 1; i++) {
            const start = vertices[i];
            const end = vertices[i + 1];
            const outTangent = outTangents[i];
            const inTangent = inTangents[i + 1];

            ctx.bezierCurveTo(
                start[0] + xTranslate + outTangent[0],
                start[1] + yTranslate + outTangent[1],
                end[0] + xTranslate + inTangent[0],
                end[1] + yTranslate + inTangent[1],
                end[0] + xTranslate,
                end[1] + yTranslate
            );
        }

        if (pathData.c) {
            // Close path with curve from last to first point
            const start = vertices[vertices.length - 1];
            const end = vertices[0];
            const outTangent = outTangents[vertices.length - 1];
            const inTangent = inTangents[0];

            ctx.bezierCurveTo(
                start[0] + xTranslate + outTangent[0],
                start[1] + yTranslate + outTangent[1],
                end[0] + xTranslate + inTangent[0],
                end[1] + yTranslate + inTangent[1],
                end[0] + xTranslate,
                end[1] + yTranslate
            );

            ctx.closePath();
        }
    }
}

function DrawFill(fill: RawFillShape, ctx: DrawingContext): void {
    // Read initial (first-frame) values so animated fills (a===1) render their starting state into the atlas
    // instead of feeding a keyframe array through `as number[]` / `as number` casts.
    const colorRgb = GetInitialColorValue(fill.c);
    const opacity = GetInitialScalarValue(fill.o, 100);
    const color = LottieColorToCSSColor(colorRgb, opacity / 100);
    ctx.fillStyle = color;

    ctx.fill();
}

function DrawStroke(stroke: RawStrokeShape, ctx: DrawingContext): void {
    // Color and opacity. Use initial-value helpers so animated stroke color/opacity render their first-frame
    // value into the atlas instead of producing NaN / malformed CSS via `as number[]` / `as number` casts.
    const opacity = stroke.o ? GetInitialScalarValue(stroke.o, 100) : 100;
    const colorRgb = stroke.c ? GetInitialColorValue(stroke.c) : [0, 0, 0];
    const color = LottieColorToCSSColor(colorRgb, opacity / 100);
    ctx.strokeStyle = color;

    ApplyStrokeStyle(stroke, ctx);

    ctx.stroke();
}

/**
 * Apply the geometric stroke styling (width, line cap, line join, miter limit, dash pattern) to the
 * drawing context. Shared by `DrawStroke` here (solid-color strokes, `ty:"st"`) and the gradient
 * stroke drawer in the gradient sub-feature (`ty:"gs"`) — both have identical width/cap/join/miter/dash
 * semantics; they only differ in how `strokeStyle` is built (CSS color vs CanvasGradient).
 * @param stroke The raw solid or gradient stroke shape to read styling from.
 * @param ctx The drawing context to mutate (`lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, dash).
 */
export function ApplyStrokeStyle(stroke: RawStrokeShape | RawGradientStrokeShape, ctx: DrawingContext): void {
    // Width
    const width = stroke.w ? GetInitialScalarValue(stroke.w, 1) : 1;
    ctx.lineWidth = width;

    // Line cap
    switch (stroke.lc) {
        case 1:
            ctx.lineCap = "butt";
            break;
        case 2:
            ctx.lineCap = "round";
            break;
        case 3:
            ctx.lineCap = "square";
            break;
        default:
            // leave default
            break;
    }

    // Line join
    switch (stroke.lj) {
        case 1:
            ctx.lineJoin = "miter";
            break;
        case 2:
            ctx.lineJoin = "round";
            break;
        case 3:
            ctx.lineJoin = "bevel";
            break;
        default:
            // leave default
            break;
    }

    // Miter limit
    if (stroke.ml !== undefined) {
        ctx.miterLimit = stroke.ml;
    }

    // Dash pattern
    const dashes = stroke.d;
    if (dashes !== undefined) {
        const lineDashes: number[] = [];
        for (let i = 0; i < dashes.length; i++) {
            if (dashes[i].n === "d") {
                // Dash length may be animated (a === 1), in which case `v.k` is a keyframe array.
                // Use GetInitialScalarValue so the first-frame length is rasterized instead of NaN.
                lineDashes.push(GetInitialScalarValue(dashes[i].v));
            }
        }

        ctx.setLineDash(lineDashes);
    } else {
        // Canvas line-dash state persists across strokes within the same `DrawVectorShape` save/restore
        // pair. Without this reset, a dashed stroke drawn earlier in the shape would leak its dash
        // pattern onto subsequent strokes that don't declare `d`.
        ctx.setLineDash([]);
    }
}

/**
 * Converts a Lottie color (normalized 0..1 RGB, optional alpha) and an extra opacity multiplier into
 * a CSS `rgba(...)` string. Shared by solid fills/strokes and the gradient drawer's color stops.
 * @param color The Lottie color as `[r, g, b]` or `[r, g, b, a]` with components in the 0..1 range.
 * @param opacity An additional opacity multiplier in the 0..1 range applied to the color's alpha.
 * @returns The equivalent CSS `rgba(...)` color string.
 */
export function LottieColorToCSSColor(color: number[], opacity: number): string {
    if (color.length !== 3 && color.length !== 4) {
        return "rgba(0, 0, 0, 1)"; // Default to black if invalid
    }

    const r = Math.round(color[0] * 255);
    const g = Math.round(color[1] * 255);
    const b = Math.round(color[2] * 255);
    const a = (color[3] || 1) * opacity;

    return `rgba(${r}, ${g}, ${b}, ${a})`;
}
