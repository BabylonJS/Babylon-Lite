import { type RawElement, type RawLottieAnimation, type RawShapeType } from "../parsing/rawTypes";

/**
 * Shape-item types that map to an independently loadable drawing sub-feature. Structural items that
 * never rasterize on their own (`gr` groups and `tr` transforms) are intentionally excluded.
 */
export type ShapeDrawItemType = "rc" | "el" | "sh" | "fl" | "st" | "gf" | "gs";

/**
 * Stable, ordered list of the shape-item types that map to a drawing sub-feature. The order is the
 * canonical detection order so callers (runtime loaders and build-time codegen) produce identical,
 * deterministic feature lists.
 */
export const ShapeDrawItemTypes: readonly ShapeDrawItemType[] = ["rc", "el", "sh", "fl", "st", "gf", "gs"] as const;

const ShapeDrawItemTypeSet = new Set<RawShapeType>(ShapeDrawItemTypes);

/**
 * Recursively collects the drawing sub-feature shape-item types in a list of shape elements into the
 * given set, walking nested groups (`it`) and skipping hidden items (`hd === true`). Shared by the
 * standalone {@link DetectShapeDrawItems} and the combined {@link DetectLottieSignals} pass so the two
 * cannot disagree about what a shape layer contains.
 * @param elements The raw shape elements to scan, or undefined.
 * @param found The set to add detected shape-item types to.
 */
export function CollectShapeDrawItems(elements: readonly RawElement[] | undefined, found: Set<ShapeDrawItemType>): void {
    if (elements === undefined) {
        return;
    }
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.hd === true) {
            continue;
        }
        // Groups (`gr`) carry their drawable items in `it`; recurse so nested shapes are detected.
        if (element.it !== undefined) {
            CollectShapeDrawItems(element.it, found);
        }
        if (ShapeDrawItemTypeSet.has(element.ty)) {
            found.add(element.ty as ShapeDrawItemType);
        }
    }
}

/**
 * Recursively scans every visible shape layer in a raw Lottie animation and reports which drawing
 * sub-features its shape items require. Walks nested groups (`it`) so deeply nested rectangles,
 * ellipses, paths, fills, strokes, and gradients are all detected. Hidden layers and hidden shape
 * items (`hd === true`) are skipped.
 *
 * The function is pure and Node-safe so it can run both on the runtime hot path and ahead of time in
 * a build step, guaranteeing the two produce the same sub-feature set.
 * @param raw Raw Lottie animation data.
 * @returns The detected shape-item types, in {@link ShapeDrawItemTypes} canonical order.
 */
export function DetectShapeDrawItems(raw: RawLottieAnimation): ShapeDrawItemType[] {
    const found = new Set<ShapeDrawItemType>();

    for (let i = 0; i < raw.layers.length; i++) {
        const layer = raw.layers[i];
        if (layer.hd === true) {
            continue;
        }
        // Only shape layers (ty:4) carry a `shapes` array. Other layer types have no drawable shape items.
        if (layer.ty !== 4) {
            continue;
        }
        const shapeLayer = layer as { shapes?: RawElement[] };
        CollectShapeDrawItems(shapeLayer.shapes, found);
    }

    // Emit in canonical order so the result is deterministic regardless of document order.
    const result: ShapeDrawItemType[] = [];
    for (let i = 0; i < ShapeDrawItemTypes.length; i++) {
        if (found.has(ShapeDrawItemTypes[i])) {
            result.push(ShapeDrawItemTypes[i]);
        }
    }
    return result;
}

export { DetectShapeDrawItems as detectShapeDrawItems };
