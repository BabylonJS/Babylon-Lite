import { type GLSprite, type GLSpriteColor } from "babylon-lite-gl/sprites";

import { type IVector2Like } from "../babylonTypes";
import { type Nullable } from "../babylonTypes";

import { InterpolateBezierEase } from "../maths/bezier";
import { type Matrix, composeMatrix, createMatrix, decomposeMatrix, multiplyMatricesToRef } from "../maths/matrix";
import { type ScalarProperty, type Vector2Property } from "../parsing/parsedTypes";

/**
 * A lottie-driven sprite: a lite-gl {@link GLSprite} whose tint (`color`) is always present, so the
 * per-frame opacity push in {@link UpdateNode} (`sprite.color.a = ...`) can target it without a guard.
 * The sprite adapter guarantees `color` is set when it creates the sprite.
 */
export type LottieSprite = GLSprite & { color: GLSpriteColor };

/**
 * Discriminates the role a node plays in the scene graph.
 * - `node`: a plain transform node (e.g. a shape group's TRS/anchor pair).
 * - `control`: a top-level layer node whose visibility is gated by an in/out frame range.
 * - `sprite`: a node that drives a renderer sprite from its world transform.
 */
export type AnimationNodeKind = "node" | "control" | "sprite";

/**
 * A node in the scene graph that carries the animation information from an animation layer or group.
 *
 * All node kinds share a single flat object shape (kind-specific fields are always present with
 * defaults) so the per-frame update path stays monomorphic. The `_kind` discriminator selects the
 * behavior applied by {@link UpdateNode}. The concrete renderer sprite is supplied later by a
 * renderer adapter through {@link AttachSprite}, so parsing and feature modules can build the graph
 * without depending on any specific rendering backend.
 */
export type AnimationNode = {
    /** Discriminates the node's role in the scene graph. */
    _kind: AnimationNodeKind;
    /** Unique identifier for the node. */
    id: string;
    /** Local position track. */
    position: Vector2Property;
    /** Local rotation track (in degrees). */
    rotation: ScalarProperty;
    /** Local scale track. */
    scale: Vector2Property;
    /** Local opacity track, from 0 to 1. */
    opacity: ScalarProperty;
    /** World matrix used for rendering (aliases `localMatrix` for roots, `globalMatrix` otherwise). */
    worldMatrix: Matrix;
    /** Local transform matrix composed from the position/rotation/scale tracks. */
    localMatrix: Matrix;
    /** Local matrix multiplied by the parent's world matrix. */
    globalMatrix: Matrix;
    /** Parent node in the scene graph, or undefined for a root node. */
    parent: AnimationNode | undefined;
    /** Child nodes in the scene graph. */
    children: AnimationNode[];
    /** Whether the node is currently visible. */
    isVisible: boolean;
    /** Whether the node has any animated track. */
    isAnimated: boolean;
    /**
     * Bitmask of which transform tracks are animated, built once at creation time.
     * Combination of {@link TrackPosition}, {@link TrackRotation} and {@link TrackScale}.
     * Replaces the previous per-track update closures so the per-frame update path can dispatch
     * directly to the evaluators without allocating or calling through a closure array.
     */
    animatedTracks: number;

    // Control-kind fields (defaults for other kinds).
    /** Frame at which a control node becomes active. */
    inFrame: number;
    /** Frame at which a control node becomes inactive (exclusive). */
    outFrame: number;
    /** Whether this control node represents a null layer (type 3). Null layers' opacity is not inherited by children. */
    isNullLayer: boolean;

    // Sprite-kind fields (defaults for other kinds).
    /** Whether this node drives a sprite. */
    isShape: boolean;
    /** Concrete renderer sprite driven by this node, attached after parsing. */
    sprite: Nullable<LottieSprite>;
    /** Unscaled sprite width in pixels. */
    originalWidth: number;
    /** Unscaled sprite height in pixels. */
    originalHeight: number;
    /** Whether the sprite has not yet been driven; forces the first transform/opacity push. */
    firstTime: boolean;
};

// Scratch storage shared across interpolation helpers. Safe because all uses are synchronous
// and the results are consumed immediately after each call.
const ScalarScratch: { value: number } = { value: 0 };
const ComposeScratchA: Matrix = createMatrix();
const ComposeScratchB: Matrix = createMatrix();
const ComposeScratchScale: IVector2Like = { x: 0, y: 0 };
const ComposeScratchPos: IVector2Like = { x: 0, y: 0 };

/** Bit flag in {@link AnimationNode.animatedTracks} marking the position track as animated. */
const TrackPosition = 1;
/** Bit flag in {@link AnimationNode.animatedTracks} marking the rotation track as animated. */
const TrackRotation = 2;
/** Bit flag in {@link AnimationNode.animatedTracks} marking the scale track as animated. */
const TrackScale = 4;

/** Temporary scale vector used during sprite updates for matrix decomposition. */
const TempScale = { x: 1, y: 1 };

function CreateBaseNode(
    kind: AnimationNodeKind,
    id: string,
    position?: Vector2Property,
    rotation?: ScalarProperty,
    scale?: Vector2Property,
    opacity?: ScalarProperty,
    parent?: AnimationNode
): AnimationNode {
    const node: AnimationNode = {
        _kind: kind,
        id,
        position: position || { startValue: { x: 0, y: 0 }, currentValue: { x: 0, y: 0 }, currentKeyframeIndex: 0 },
        rotation: rotation || { startValue: 0, currentValue: 0, currentKeyframeIndex: 0 },
        scale: scale || { startValue: { x: 1, y: 1 }, currentValue: { x: 1, y: 1 }, currentKeyframeIndex: 0 },
        opacity: opacity || { startValue: 1, currentValue: 1, currentKeyframeIndex: 0 },
        localMatrix: createMatrix(),
        globalMatrix: createMatrix(),
        // Assigned below once parenting is known.
        worldMatrix: undefined as unknown as Matrix,
        parent: undefined,
        children: [],
        isVisible: false,
        isAnimated: false,
        animatedTracks: 0,
        inFrame: 0,
        outFrame: 0,
        isNullLayer: false,
        isShape: false,
        sprite: null,
        originalWidth: 0,
        originalHeight: 0,
        firstTime: true,
    };

    // Store the matrix at least once.
    composeMatrix(node.localMatrix, node.scale.currentValue, node.rotation.currentValue, node.position.currentValue);

    // Animated ? Record which tracks are animated in a numeric bitmask so the per-frame update
    // path can dispatch directly to the evaluators without a closure array.
    let animatedTracks = 0;
    if (node.position.track !== undefined && node.position.track.count > 0) {
        animatedTracks |= TrackPosition;
    }

    if (node.rotation.track !== undefined && node.rotation.track.count > 0) {
        animatedTracks |= TrackRotation;
    }

    if (node.scale.track !== undefined && node.scale.track.count > 0) {
        animatedTracks |= TrackScale;
    }

    node.animatedTracks = animatedTracks;
    node.isAnimated = animatedTracks !== 0;

    // Parenting
    if (parent) {
        node.worldMatrix = node.globalMatrix;

        node.parent = parent;
        parent.children.push(node);
        multiplyMatricesToRef(node.localMatrix, parent.worldMatrix, node.globalMatrix);
    } else {
        node.worldMatrix = node.localMatrix;
    }

    return node;
}

/**
 * Creates a plain transform node.
 * @param id Unique identifier for the node.
 * @param position Position of the node in the scene.
 * @param rotation Rotation of the node in degrees.
 * @param scale Scale of the node in the scene.
 * @param opacity Opacity of the node, from 0 to 1.
 * @param parent Parent node in the scene graph.
 * @returns The new node.
 */
export function CreateNode(
    id: string,
    position?: Vector2Property,
    rotation?: ScalarProperty,
    scale?: Vector2Property,
    opacity?: ScalarProperty,
    parent?: AnimationNode
): AnimationNode {
    return CreateBaseNode("node", id, position, rotation, scale, opacity, parent);
}

/**
 * Creates a top-level control node whose visibility is gated by an in/out frame range.
 * Each top-level layer in the animation is represented by a control node.
 * @param id Unique identifier for the node.
 * @param inFrame Frame at which the node becomes active.
 * @param outFrame Frame at which the node becomes inactive.
 * @param position Position of the node in the scene.
 * @param rotation Rotation of the node in degrees.
 * @param scale Scale of the node in the scene.
 * @param opacity Opacity of the node, from 0 to 1.
 * @param parent Parent node in the scene graph.
 * @param isNullLayer Whether this control node represents a null layer (type 3). Null layers' opacity is not inherited by children.
 * @returns The new control node.
 */
export function CreateControlNode(
    id: string,
    inFrame: number,
    outFrame: number,
    position?: Vector2Property,
    rotation?: ScalarProperty,
    scale?: Vector2Property,
    opacity?: ScalarProperty,
    parent?: AnimationNode,
    isNullLayer?: boolean
): AnimationNode {
    const node = CreateBaseNode("control", id, position, rotation, scale, opacity, parent);
    node.inFrame = inFrame;
    node.outFrame = outFrame;
    node.isNullLayer = isNullLayer ?? false;
    return node;
}

/**
 * Creates a sprite node that drives a renderer sprite from its world transform.
 * @param id Unique identifier for the sprite node.
 * @param originalWidth The unscaled sprite width in pixels.
 * @param originalHeight The unscaled sprite height in pixels.
 * @param position The position of the sprite in the scene.
 * @param rotation The rotation of the sprite in degrees.
 * @param scale The scale of the sprite in the scene.
 * @param opacity The opacity of the sprite.
 * @param parent The parent node in the scene graph.
 * @returns The new sprite node.
 */
export function CreateSpriteNode(
    id: string,
    originalWidth: number,
    originalHeight: number,
    position?: Vector2Property,
    rotation?: ScalarProperty,
    scale?: Vector2Property,
    opacity?: ScalarProperty,
    parent?: AnimationNode
): AnimationNode {
    const node = CreateBaseNode("sprite", id, position, rotation, scale, opacity, parent);
    node.originalWidth = originalWidth;
    node.originalHeight = originalHeight;
    node.isShape = true;
    node.firstTime = true;
    return node;
}

/**
 * Attaches the concrete sprite driven by a sprite node.
 * Called by the renderer adapter after parsing, once the rendering backend's sprite exists.
 * @param node The sprite node to drive the sprite from.
 * @param sprite The sprite to drive from the node's transform.
 */
export function AttachSprite(node: AnimationNode, sprite: LottieSprite): void {
    node.sprite = sprite;
    node.firstTime = true;
}

/**
 * Gets the effective opacity of a node.
 * If the node is not visible, the opacity is 0. The opacity is multiplied by the parent opacity,
 * except when the parent is a null layer, in which case its opacity is skipped.
 * @param node The node to evaluate.
 * @returns The opacity of the node, from 0 to 1.
 */
export function GetNodeOpacity(node: AnimationNode): number {
    if (!node.isVisible) {
        return 0;
    }

    if (node.opacity.currentValue === 0) {
        return 0;
    }

    // Skip parent opacity if parent is a null layer control node - null layers may have opacity 0
    // but their children should still be visible. Still multiply by the null layer's parent opacity
    // so that ancestors above the null layer are respected.
    if (node.parent && node.parent.isNullLayer) {
        return node.opacity.currentValue * (node.parent.parent ? GetNodeOpacity(node.parent.parent) : 1);
    }

    return node.opacity.currentValue * (node.parent ? GetNodeOpacity(node.parent) : 1);
}

/**
 * Sets a node's visibility and propagates it to all descendants.
 * @param node The node to update.
 * @param value The new visibility value.
 */
export function SetNodeVisible(node: AnimationNode, value: boolean): void {
    if (node.isVisible === value) {
        return; // No change in visibility
    }
    node.isVisible = value;
    // Propagate to children
    for (let i = 0; i < node.children.length; i++) {
        SetNodeVisible(node.children[i], value);
    }
}

/**
 * Resets a node's properties to their initial values.
 * @param node The node to reset.
 */
export function ResetNode(node: AnimationNode): void {
    // Vectors need to be copied to avoid modifying the original start values
    node.position.currentValue = { x: node.position.startValue.x, y: node.position.startValue.y };
    if (node.position.track) {
        node.position.currentKeyframeIndex = 0;
    }

    node.rotation.currentValue = node.rotation.startValue;
    if (node.rotation.track) {
        node.rotation.currentKeyframeIndex = 0;
    }

    node.scale.currentValue = { x: node.scale.startValue.x, y: node.scale.startValue.y };
    if (node.scale.track) {
        node.scale.currentKeyframeIndex = 0;
    }

    node.opacity.currentValue = node.opacity.startValue;
    if (node.opacity.track) {
        node.opacity.currentKeyframeIndex = 0;
    }

    for (let i = 0; i < node.children.length; i++) {
        ResetNode(node.children[i]);
    }

    // On reset update the scenegraph so all matrices are reset to their initial values
    if (node.parent === undefined) {
        UpdateNode(node, 0, false, true);
    }

    node.isVisible = false;
}

/**
 * Updates a node's properties based on the current frame of the animation.
 * Control nodes are gated by their in/out frame range; sprite nodes additionally drive their sprite.
 * @param node The node to update.
 * @param frame Frame number we are playing in the animation.
 * @param isParentUpdated Whether the parent node has been updated.
 * @param isReset Whether the node is being reset.
 * @returns True if the node was updated, false otherwise.
 */
export function UpdateNode(node: AnimationNode, frame: number, isParentUpdated = false, isReset = false): boolean {
    // Control nodes only update when the frame is within the in and out range.
    if (node._kind === "control") {
        SetNodeVisible(node, frame >= node.inFrame && frame < node.outFrame);
    }

    let isUpdated = isReset;

    if (node.isAnimated) {
        // Direct dispatch by track bitmask; each evaluator runs every frame (matching the prior
        // closure loop) so sequential-keyframe state advances even when the value is unchanged.
        const tracks = node.animatedTracks;
        if (tracks & TrackPosition) {
            isUpdated = UpdatePosition(node, frame) || isUpdated;
        }
        if (tracks & TrackRotation) {
            isUpdated = UpdateRotation(node, frame) || isUpdated;
        }
        if (tracks & TrackScale) {
            isUpdated = UpdateScale(node, frame) || isUpdated;
        }

        if (isUpdated) {
            composeMatrix(node.localMatrix, node.scale.currentValue, node.rotation.currentValue, node.position.currentValue);
        }
    }

    if (node.parent) {
        if (isParentUpdated || isUpdated) {
            multiplyMatricesToRef(node.localMatrix, node.parent.worldMatrix, node.globalMatrix);
        }
    }

    UpdateOpacity(node, frame);

    for (let i = 0; i < node.children.length; i++) {
        UpdateNode(node.children[i], frame, isUpdated || isParentUpdated, isReset);
    }

    const isDirty = isUpdated || isParentUpdated;

    // Sprite nodes drive their renderer sprite from the freshly computed world transform.
    if (node._kind === "sprite") {
        const spriteIsDirty = isDirty || node.firstTime;

        const sprite = node.sprite;
        if (sprite === null) {
            return spriteIsDirty;
        }

        node.firstTime = false;

        if (spriteIsDirty) {
            const rotation = decomposeMatrix(node.worldMatrix, TempScale, sprite.position);

            // Apply scaling to the original sprite dimensions
            sprite.width = node.originalWidth * TempScale.x;
            sprite.height = node.originalHeight * TempScale.y;

            // Rotation
            sprite.angle = rotation;
        }

        // Opacity
        sprite.color.a = GetNodeOpacity(node);

        return spriteIsDirty;
    }

    return isDirty;
}

/**
 * Evaluates the world matrix of a node at a specific frame without mutating any node state.
 * @param node The node to evaluate.
 * @param frame The frame number to evaluate at.
 * @param scale Output vector to receive the decomposed scale.
 * @param translation Output vector to receive the decomposed translation.
 * @returns The rotation in radians.
 */
export function DecomposeWorldMatrixAtFrame(node: AnimationNode, frame: number, scale: IVector2Like, translation: IVector2Like): number {
    // Collect the chain from this node up to the root.
    const chain: AnimationNode[] = [node];
    let parent = node.parent;
    while (parent) {
        chain.push(parent);
        parent = parent.parent;
    }

    // Iterative compose: two matrices + two vector scratches, independent of chain depth.
    const acc = ComposeScratchA;
    const tmp = ComposeScratchB;
    const scratchScale = ComposeScratchScale;
    const scratchPos = ComposeScratchPos;

    ComposeLocalAtFrame(chain[0], frame, acc, scratchScale, scratchPos);
    for (let i = 1; i < chain.length; i++) {
        ComposeLocalAtFrame(chain[i], frame, tmp, scratchScale, scratchPos);
        // world(node) = node_local * parent_world, so accumulate: acc = acc * ancestor_local.
        // multiplyMatricesToRef captures all inputs before writing, so acc can be the output.
        multiplyMatricesToRef(acc, tmp, acc);
    }

    return decomposeMatrix(acc, scale, translation);
}

function ComposeLocalAtFrame(node: AnimationNode, frame: number, output: Matrix, scratchScale: IVector2Like, scratchPos: IVector2Like): void {
    const scaleIdx = InterpolateVector2AtFrame(node.scale, frame, 0, scratchScale);
    const scale = scaleIdx >= 0 ? scratchScale : node.scale.startValue;

    const rotationIdx = InterpolateScalarAtFrame(node.rotation, frame, 0, ScalarScratch);
    // Keyframe values are stored without negation (negation is applied at runtime),
    // but startValue is already negated by the parser, so only negate interpolated results.
    const rotation = rotationIdx >= 0 ? -ScalarScratch.value : node.rotation.startValue;

    const positionIdx = InterpolateVector2AtFrame(node.position, frame, 0, scratchPos);
    const position = positionIdx >= 0 ? scratchPos : node.position.startValue;

    composeMatrix(output, scale, rotation, position);
}

/**
 * Interpolates a Vector2 property at a given frame and writes the result into `output`.
 * @param property The Vector2 property to interpolate.
 * @param frame The frame number to evaluate at.
 * @param startIndex The keyframe index to start scanning from (for sequential playback optimization).
 * @param output The vector that receives the interpolated value (only written when the return value is not -1).
 * @returns The resolved segment index (0..len-2), or `len-1` if the frame is at/after the last keyframe,
 * or `-1` if the frame is before the first keyframe or the property has no keyframes (in which case
 * `output` is left unchanged).
 */
function InterpolateVector2AtFrame(property: Vector2Property, frame: number, startIndex: number, output: IVector2Like): number {
    const track = property.track;
    if (track === undefined || track.count === 0) {
        return -1;
    }

    const times = track.times;
    if (frame < times[0]) {
        return -1;
    }

    const lastIdx = track.count - 1;
    if (frame >= times[lastIdx]) {
        output.x = track.valuesX[lastIdx];
        output.y = track.valuesY[lastIdx];
        return lastIdx;
    }

    let segmentIndex = -1;
    for (let i = startIndex; i < lastIdx; i++) {
        if (frame >= times[i] && frame < times[i + 1]) {
            segmentIndex = i;
            break;
        }
    }

    if (segmentIndex === -1) {
        return -1;
    }

    const gradient = (frame - times[segmentIndex]) / (times[segmentIndex + 1] - times[segmentIndex]);

    const b = segmentIndex * 4;
    const easeFactor1 = InterpolateBezierEase(track.bezierX[b], track.bezierX[b + 1], track.bezierX[b + 2], track.bezierX[b + 3], track.easingSteps, gradient);
    const easeFactor2 = InterpolateBezierEase(track.bezierY[b], track.bezierY[b + 1], track.bezierY[b + 2], track.bezierY[b + 3], track.easingSteps, gradient);

    const currentX = track.valuesX[segmentIndex];
    const currentY = track.valuesY[segmentIndex];
    output.x = currentX + easeFactor1 * (track.valuesX[segmentIndex + 1] - currentX);
    output.y = currentY + easeFactor2 * (track.valuesY[segmentIndex + 1] - currentY);
    return segmentIndex;
}

/**
 * Interpolates a scalar property at a given frame and writes the result into `output.value`.
 * @param property The scalar property to interpolate.
 * @param frame The frame number to evaluate at.
 * @param startIndex The keyframe index to start scanning from (for sequential playback optimization).
 * @param output Holder that receives the interpolated value (only written when the return value is not -1).
 * @returns The resolved segment index (0..len-2), or `len-1` if the frame is at/after the last keyframe,
 * or `-1` if the frame is before the first keyframe or the property has no keyframes (in which case
 * `output.value` is left unchanged).
 */
function InterpolateScalarAtFrame(property: ScalarProperty, frame: number, startIndex: number, output: { value: number }): number {
    const track = property.track;
    if (track === undefined || track.count === 0) {
        return -1;
    }

    const times = track.times;
    if (frame < times[0]) {
        return -1;
    }

    const lastIdx = track.count - 1;
    if (frame >= times[lastIdx]) {
        output.value = track.values[lastIdx];
        return lastIdx;
    }

    let segmentIndex = -1;
    for (let i = startIndex; i < lastIdx; i++) {
        if (frame >= times[i] && frame < times[i + 1]) {
            segmentIndex = i;
            break;
        }
    }

    if (segmentIndex === -1) {
        return -1;
    }

    const gradient = (frame - times[segmentIndex]) / (times[segmentIndex + 1] - times[segmentIndex]);

    const b = segmentIndex * 4;
    const easeFactor = InterpolateBezierEase(track.bezier[b], track.bezier[b + 1], track.bezier[b + 2], track.bezier[b + 3], track.easingSteps, gradient);
    const currentValue = track.values[segmentIndex];
    output.value = currentValue + easeFactor * (track.values[segmentIndex + 1] - currentValue);
    return segmentIndex;
}

function UpdatePosition(node: AnimationNode, frame: number): boolean {
    const idx = InterpolateVector2AtFrame(node.position, frame, node.position.currentKeyframeIndex, node.position.currentValue);
    if (idx < 0) {
        return false;
    }
    // Only advance when we resolved a real segment; leave the index alone when clamped to the last keyframe
    // to match prior behavior (the original update loop only ran up to count - 1, exclusive).
    if (idx < node.position.track!.count - 1) {
        node.position.currentKeyframeIndex = idx;
    }
    return true;
}

function UpdateRotation(node: AnimationNode, frame: number): boolean {
    const idx = InterpolateScalarAtFrame(node.rotation, frame, node.rotation.currentKeyframeIndex, ScalarScratch);
    if (idx < 0) {
        return false;
    }
    if (idx < node.rotation.track!.count - 1) {
        node.rotation.currentKeyframeIndex = idx;
    }
    node.rotation.currentValue = -ScalarScratch.value;
    return true;
}

function UpdateScale(node: AnimationNode, frame: number): boolean {
    const idx = InterpolateVector2AtFrame(node.scale, frame, node.scale.currentKeyframeIndex, node.scale.currentValue);
    if (idx < 0) {
        return false;
    }
    if (idx < node.scale.track!.count - 1) {
        node.scale.currentKeyframeIndex = idx;
    }
    return true;
}

function UpdateOpacity(node: AnimationNode, frame: number): boolean {
    if (node.opacity.track === undefined || node.opacity.track.count === 0) {
        return false;
    }

    const idx = InterpolateScalarAtFrame(node.opacity, frame, node.opacity.currentKeyframeIndex, ScalarScratch);
    if (idx < 0) {
        return false;
    }
    if (idx < node.opacity.track.count - 1) {
        node.opacity.currentKeyframeIndex = idx;
    }
    node.opacity.currentValue = ScalarScratch.value;
    return true;
}
