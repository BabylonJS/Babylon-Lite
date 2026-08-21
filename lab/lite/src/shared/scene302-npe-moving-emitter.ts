export const SCENE302_CAPTURE_SEEK_TIME = 2;
export const SCENE302_STEPS_PER_SECOND = 60;
export const SCENE302_TEXTURE_SIZE = 64;
export const SCENE302_CLEAR_COLOR = [0.008, 0.012, 0.025, 1] as const;
export const SCENE302_CAMERA_ALPHA = -Math.PI / 2;
export const SCENE302_CAMERA_BETA = 1.2;
export const SCENE302_CAMERA_RADIUS = 8.5;
export const SCENE302_CAMERA_TARGET = [0, 0.35, 0] as const;
export const SCENE302_MOTION_PERIOD_SECONDS = 4.8;

export interface Scene302EmitterPose {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly angle: number;
}

export interface Scene302MutableMatrix {
    [index: number]: number;
}

/** Compact authored graph covering local births and LocalPositionUpdated under a moving emitter. */
export function createScene302NpeGraph(): object {
    return {
        name: "Scene 302 moving local emitter",
        customType: "BABYLON.NodeParticleSystemSet",
        blocks: [
            {
                customType: "BABYLON.SystemBlock",
                id: 1,
                name: "Moving local system",
                capacity: 640,
                updateSpeed: 1 / SCENE302_STEPS_PER_SECOND,
                preWarmCycles: 0,
                preWarmStepOffset: 1,
                blendMode: 0,
                isBillboardBased: true,
                billBoardMode: 7,
                isLocal: true,
                inputs: [
                    { name: "particle", inputName: "particle", targetBlockId: 4, targetConnectionName: "output" },
                    { name: "emitRate", valueType: "number", value: 130 },
                    { name: "texture", inputName: "texture", targetBlockId: 6, targetConnectionName: "texture" },
                    { name: "targetStopDuration", valueType: "number", value: 0 },
                ],
            },
            {
                customType: "BABYLON.CreateParticleBlock",
                id: 2,
                name: "Create particle",
                inputs: [
                    { name: "emitPower", valueType: "number", value: 1.45 },
                    { name: "lifeTime", valueType: "number", value: 2.1 },
                    { name: "color", valueType: "BABYLON.Color4", value: [0.32, 0.78, 1, 0.95] },
                    { name: "colorDead", valueType: "BABYLON.Color4", value: [0.08, 0.12, 0.5, 0] },
                    { name: "scale", valueType: "BABYLON.Vector2", value: [0.72, 1] },
                    { name: "angle", valueType: "number", value: 0 },
                    { name: "size", valueType: "number", value: 0.3 },
                ],
            },
            {
                customType: "BABYLON.PointShapeBlock",
                id: 3,
                name: "Directional point",
                inputs: [
                    { name: "particle", inputName: "particle", targetBlockId: 2, targetConnectionName: "particle" },
                    { name: "direction1", valueType: "BABYLON.Vector3", value: [-0.12, 1.25, -0.08] },
                    { name: "direction2", valueType: "BABYLON.Vector3", value: [0.12, 1.75, 0.08] },
                ],
            },
            {
                customType: "BABYLON.UpdatePositionBlock",
                id: 4,
                name: "Update position",
                inputs: [
                    { name: "particle", inputName: "particle", targetBlockId: 3, targetConnectionName: "output" },
                    { name: "position", inputName: "position", targetBlockId: 5, targetConnectionName: "output" },
                ],
            },
            {
                customType: "BABYLON.ParticleInputBlock",
                id: 5,
                name: "Local position updated",
                type: 8,
                contextualValue: 0x18,
                systemSource: 0,
                inputs: [],
            },
            {
                customType: "BABYLON.ParticleTextureSourceBlock",
                id: 6,
                name: "Procedural radial texture",
                url: "",
                inputs: [],
            },
        ],
    };
}

export function buildScene302TexturePixels(): Uint8Array {
    const pixels = new Uint8Array(SCENE302_TEXTURE_SIZE * SCENE302_TEXTURE_SIZE * 4);
    for (let y = 0; y < SCENE302_TEXTURE_SIZE; y++) {
        for (let x = 0; x < SCENE302_TEXTURE_SIZE; x++) {
            const dx = (x + 0.5) / SCENE302_TEXTURE_SIZE - 0.5;
            const dy = (y + 0.5) / SCENE302_TEXTURE_SIZE - 0.5;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const alpha = Math.max(0, Math.min(1, (0.48 - distance) / 0.32));
            const offset = (y * SCENE302_TEXTURE_SIZE + x) * 4;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = Math.round(alpha * 255);
        }
    }
    return pixels;
}

export function createScene302SeededRandom(seed = 1): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

export function getScene302StepCount(seekTime: number): number {
    return Math.round(seekTime * SCENE302_STEPS_PER_SECOND);
}

export function getScene302EmitterPose(timeSeconds: number): Scene302EmitterPose {
    const phase = ((timeSeconds % SCENE302_MOTION_PERIOD_SECONDS) / SCENE302_MOTION_PERIOD_SECONDS) * Math.PI * 2;
    return {
        x: Math.cos(phase) * 1.8,
        y: 0.25 + Math.sin(phase * 2) * 0.7,
        z: Math.sin(phase) * 0.75,
        angle: phase,
    };
}

export function getScene302EmitterPoseForStep(step: number): Scene302EmitterPose {
    return getScene302EmitterPose(step / SCENE302_STEPS_PER_SECOND);
}

export function writeScene302EmitterMatrix(matrix: Scene302MutableMatrix, pose: Scene302EmitterPose): void {
    const cosine = Math.cos(pose.angle);
    const sine = Math.sin(pose.angle);
    matrix[0] = cosine;
    matrix[1] = sine;
    matrix[2] = 0;
    matrix[3] = 0;
    matrix[4] = -sine;
    matrix[5] = cosine;
    matrix[6] = 0;
    matrix[7] = 0;
    matrix[8] = 0;
    matrix[9] = 0;
    matrix[10] = 1;
    matrix[11] = 0;
    matrix[12] = pose.x;
    matrix[13] = pose.y;
    matrix[14] = pose.z;
    matrix[15] = 1;
}
