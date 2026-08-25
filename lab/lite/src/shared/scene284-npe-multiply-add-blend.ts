import {
    buildScene283TexturePixels,
    createScene283NpeJson,
    SCENE283_CAMERA_RADIUS,
    SCENE283_CLEAR_COLOR,
    SCENE283_TEXTURE_SIZE,
} from "./scene283-npe-multiply-blend.js";

export const SCENE284_CAMERA_RADIUS = SCENE283_CAMERA_RADIUS;
export const SCENE284_CLEAR_COLOR = SCENE283_CLEAR_COLOR;
export const SCENE284_STEPS = 20;
export const SCENE284_TEXTURE_SIZE = SCENE283_TEXTURE_SIZE;
export const buildScene284TexturePixels = buildScene283TexturePixels;

/** Sparse deterministic NPE fixture for Babylon.js MultiplyAdd blend mode. */
export function createScene284NpeJson(): unknown {
    return createScene283NpeJson({ blendMode: 4 });
}
