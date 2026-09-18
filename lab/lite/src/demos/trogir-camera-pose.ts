const EPSILON = 1e-6;
const RAD_TO_DEG = 180 / Math.PI;

export interface TrogirCameraPose {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
    readonly pitch: number;
    readonly roll: number;
}

export interface FormattedTrogirCameraPose {
    readonly x: string;
    readonly y: string;
    readonly z: string;
    readonly yaw: string;
    readonly pitch: string;
    readonly roll: string;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= EPSILON) {
        throw new RangeError("[TrogirCameraPose] camera world matrix has an invalid basis.");
    }
    return [x / length, y / length, z / length];
}

function normalizeRadians(value: number): number {
    const wrapped = ((((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    return Math.abs(wrapped) < EPSILON ? 0 : wrapped;
}

export function readTrogirCameraPose(world: ArrayLike<number>): TrogirCameraPose {
    const [forwardX, forwardY, forwardZ] = normalize3(world[8]!, world[9]!, world[10]!);
    const [rightX, rightY, rightZ] = normalize3(world[0]!, world[1]!, world[2]!);
    const [upX, upY, upZ] = normalize3(world[4]!, world[5]!, world[6]!);
    const determinant = (rightY * upZ - rightZ * upY) * forwardX + (rightZ * upX - rightX * upZ) * forwardY + (rightX * upY - rightY * upX) * forwardZ;
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= EPSILON) {
        throw new RangeError("[TrogirCameraPose] camera world matrix has a singular basis.");
    }
    if (![world[12], world[13], world[14]].every((value) => Number.isFinite(value))) {
        throw new RangeError("[TrogirCameraPose] camera world position is not finite.");
    }
    const horizontalForward = Math.hypot(forwardX, forwardZ);
    let yaw: number;
    if (horizontalForward > EPSILON) {
        yaw = Math.atan2(forwardX, forwardZ);
    } else {
        const horizontalRight = Math.hypot(rightX, rightZ);
        if (horizontalRight > EPSILON) {
            yaw = Math.atan2(-rightZ, rightX);
        } else {
            yaw = Math.atan2(upX, upZ);
        }
    }

    const referenceRightX = Math.cos(yaw);
    const referenceRightZ = -Math.sin(yaw);
    const referenceUpX = -forwardY * referenceRightZ;
    const referenceUpY = forwardZ * referenceRightX - forwardX * referenceRightZ;
    const referenceUpZ = forwardY * referenceRightX;
    const roll = Math.atan2(rightX * referenceUpX + rightY * referenceUpY + rightZ * referenceUpZ, rightX * referenceRightX + rightZ * referenceRightZ);

    return {
        x: world[12]!,
        y: world[13]!,
        z: world[14]!,
        yaw: normalizeRadians(yaw) * RAD_TO_DEG,
        pitch: Math.atan2(forwardY, horizontalForward) * RAD_TO_DEG,
        roll: normalizeRadians(roll) * RAD_TO_DEG,
    };
}

function fixed(value: number): string {
    if (!Number.isFinite(value)) {
        throw new RangeError("[TrogirCameraPose] derived camera pose is not finite.");
    }
    const rounded = Math.abs(value) < 0.005 ? 0 : value;
    return rounded.toFixed(2);
}

export function formatTrogirCameraPose(world: ArrayLike<number>): FormattedTrogirCameraPose {
    const pose = readTrogirCameraPose(world);
    return {
        x: fixed(pose.x),
        y: fixed(pose.y),
        z: fixed(pose.z),
        yaw: fixed(pose.yaw),
        pitch: fixed(pose.pitch),
        roll: fixed(pose.roll),
    };
}
