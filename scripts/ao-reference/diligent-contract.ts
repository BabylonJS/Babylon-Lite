export interface DiligentCaptureConfig {
    scene?: "kitchen";
    width: number;
    height: number;
    warmup: number;
    travel: number;
    hold: number;
    step: number;
    withReferenceMean?: boolean;
}

export interface DiligentCaptureFrame {
    cameraAngle?: number;
    signedNormalSha256?: string;
    index: number;
    phase: number;
    sphereX: number;
    stage: "warmup" | "forward" | "hold" | "reverse" | "rest";
}

export const DILIGENT_CAMERA_BYTES = 576;
export const DILIGENT_FRAME_MAGIC = 0x31464f41;

export function unorm8ToHalf(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error("Expected an unsigned AO byte.");
    }
    if (value === 0) {
        return 0;
    }
    const normalized = value / 255;
    const exponent = Math.floor(Math.log2(normalized));
    return ((exponent + 15) << 10) + Math.round((normalized / 2 ** exponent - 1) * 1024);
}

export function validateDiligentConfig(config: DiligentCaptureConfig): void {
    const integers = [config.width, config.height, config.warmup, config.travel, config.hold];
    if (
        integers.some((value) => !Number.isInteger(value)) ||
        config.width < 16 ||
        config.height < 16 ||
        config.width > 1920 ||
        config.height > 1080 ||
        config.warmup < 1 ||
        config.warmup > 64 ||
        config.travel < 1 ||
        config.travel > 120 ||
        config.hold < 1 ||
        config.hold > 64 ||
        !Number.isFinite(config.step) ||
        config.step <= 0 ||
        config.step > 0.1 ||
        (config.withReferenceMean !== undefined && typeof config.withReferenceMean !== "boolean") ||
        (config.scene !== undefined && config.scene !== "kitchen") ||
        (config.scene === "kitchen" && config.withReferenceMean === true)
    ) {
        throw new Error("Invalid bounded Diligent capture configuration.");
    }
}

export function diligentFrameCount(config: DiligentCaptureConfig): number {
    return config.warmup + 2 * (config.travel + config.hold);
}

export function diligentFrame(config: DiligentCaptureConfig, index: number): DiligentCaptureFrame {
    if (!Number.isInteger(index) || index < 0 || index >= diligentFrameCount(config)) {
        throw new Error("Diligent sequence frame index is out of range.");
    }
    const moving = index - config.warmup;
    if (moving < 0) {
        return { index, phase: index % 64, sphereX: -0.8, stage: "warmup" };
    }
    if (moving < config.travel) {
        return { index, phase: index % 64, sphereX: -0.8 + (moving + 1) * config.step, stage: "forward" };
    }
    if (moving < config.travel + config.hold) {
        return { index, phase: index % 64, sphereX: -0.8 + config.travel * config.step, stage: "hold" };
    }
    if (moving < 2 * config.travel + config.hold) {
        return { index, phase: index % 64, sphereX: -0.8 + (2 * config.travel + config.hold - moving - 1) * config.step, stage: "reverse" };
    }
    return { index, phase: index % 64, sphereX: -0.8, stage: "rest" };
}

export function diligentFrameBytes(config: DiligentCaptureConfig, index: number): number {
    return 16 + 2 * DILIGENT_CAMERA_BYTES + config.width * config.height * (26 + (index === 0 ? 16 : 0)) + 1;
}

export function transposeCameraMatrix(target: Float32Array, offset: number, matrix: ArrayLike<number>): void {
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            target[offset + column * 4 + row] = matrix[row * 4 + column]!;
        }
    }
}

export function halfToFloat(value: number): number {
    const exponent = (value >> 10) & 31;
    const mantissa = value & 1023;
    if (exponent === 31) {
        return mantissa ? NaN : value & 32768 ? -Infinity : Infinity;
    }

    return (value & 32768 ? -1 : 1) * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15));
}

/** CPU mirror of the temporal geometry history's octahedral world-normal word (two snorm16). */
export function geometryNormalBits(x: number, y: number, z: number): number {
    const l1 = Math.max(Math.abs(x) + Math.abs(y) + Math.abs(z), 1e-20);
    let ex = x / l1,
        ey = y / l1;
    if (z < 0) {
        [ex, ey] = [(1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1), (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1)];
    }
    const snorm = (v: number): number => Math.floor(0.5 + 32767 * Math.min(1, Math.max(-1, v))) & 0xffff;
    return (snorm(ex) | (snorm(ey) << 16)) >>> 0;
}

/** Decode a geometry-history normal word exactly as the temporal shaders do. */
export function geometryNormal(bits: number): [number, number, number] {
    const unpack = (value: number): number => Math.max(-1, ((value << 16) >> 16) / 32767);
    let x = unpack(bits & 0xffff),
        y = unpack(bits >>> 16);
    const z = 1 - Math.abs(x) - Math.abs(y);
    const fold = Math.max(-z, 0);
    x += x >= 0 ? -fold : fold;
    y += y >= 0 ? -fold : fold;
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
}

export function decodeWorldNormalHalf(value: number): number {
    const encoded = halfToFloat(value);
    // FP32 normalization can put a biased axis normal a few ulps below zero.
    if (!Number.isFinite(encoded) || encoded < -(2 ** -23) || encoded > 1 + 2 ** -23) {
        throw new Error("Invalid encoded BLite world-normal component.");
    }
    return 2 * encoded - 1;
}
