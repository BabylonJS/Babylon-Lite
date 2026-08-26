import { type BoundingBox } from "../../maths/boundingBox";
import { type RawElement } from "../../parsing/rawTypes";
import { type SpritePackerDrawingContext } from "../../parsing/spritePacker";

/**
 * Draws a single Lottie shape item of a supported `ty` into an atlas cell using the Canvas2D API.
 * The drawing context is already translated, scaled, and clipped to the shape's bounding box by the
 * dispatcher ({@link DrawVectorShape}); the drawer only emits geometry/paint for its own item.
 * @param shape The raw shape item to draw.
 * @param boundingBox The shape bounding box in Lottie coordinates.
 * @param ctx The atlas page drawing context.
 */
export type ShapeDrawFn = (shape: RawElement, boundingBox: BoundingBox, ctx: SpritePackerDrawingContext) => void;

/**
 * A self-describing drawer for one or more Lottie shape-item types. Sub-features that can be loaded
 * on demand (for example gradients) ship a {@link ShapeDrawer} so the base shape rasterizer can
 * dispatch the matching shape items to them without statically importing their code.
 */
export type ShapeDrawer = {
    /** The Lottie shape-item `ty` values this drawer handles. */
    types: readonly string[];
    /** Draws one shape item of a handled type. */
    draw: ShapeDrawFn;
};
