import { CreateNode, type AnimationNode } from "../nodes/node";
import { type Transform } from "./parsedTypes";
import { type RawLottieLayer } from "./rawTypes";

/**
 * Builds the standard null/anchor node for a layer.
 * Shared by the layer dispatcher and the solid/shape/text features so they all produce the same
 * anchor-node structure without calling back into the parser.
 * @param layer The raw lottie layer being parsed.
 * @param transform The already parsed layer transform.
 * @param parent The parent node in the animation tree.
 * @returns The anchor node positioned at the layer's anchor point.
 */
export function ParseNullLayer(layer: RawLottieLayer, transform: Transform, parent: AnimationNode): AnimationNode {
    return CreateNode(
        `Node (Anchor) - ${layer.nm}`,
        transform.anchorPoint,
        undefined, // Rotation is not used for anchor point
        undefined, // Scale is not used for anchor point
        undefined, // Opacity is not used for anchor point
        parent
    );
}
