import { invertMat4 } from "./invert-mat4.js";
import type { Mat4 } from "./types.js";

const planckianLocus: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0.18006, 0.26352, -0.24341],
    [10, 0.18066, 0.26589, -0.25479],
    [20, 0.18133, 0.26846, -0.26876],
    [30, 0.18208, 0.27119, -0.28539],
    [40, 0.18293, 0.27407, -0.3047],
    [50, 0.18388, 0.27709, -0.32675],
    [60, 0.18494, 0.28021, -0.35156],
    [70, 0.18611, 0.28342, -0.37915],
    [80, 0.1874, 0.28668, -0.40955],
    [90, 0.1888, 0.28997, -0.44278],
    [100, 0.19032, 0.29326, -0.47888],
    [125, 0.19462, 0.30141, -0.58204],
    [150, 0.19962, 0.30921, -0.70471],
    [175, 0.20525, 0.31647, -0.84901],
    [200, 0.21142, 0.32312, -1.0182],
    [225, 0.21807, 0.32909, -1.2168],
    [250, 0.22511, 0.33439, -1.4512],
    [275, 0.23247, 0.33904, -1.7298],
    [300, 0.2401, 0.34308, -2.0637],
    [325, 0.24792, 0.34655, -2.4681],
    [350, 0.25591, 0.34951, -2.9641],
    [375, 0.264, 0.352, -3.5814],
    [400, 0.27218, 0.35407, -4.3633],
    [425, 0.28039, 0.35577, -5.3762],
    [450, 0.28863, 0.35714, -6.7262],
    [475, 0.29685, 0.35823, -8.5955],
    [500, 0.30505, 0.35907, -11.324],
    [525, 0.3132, 0.35968, -15.628],
    [550, 0.32129, 0.36011, -23.325],
    [575, 0.32931, 0.36038, -40.77],
    [600, 0.33724, 0.36051, -116.45],
];

export const MinTemperatureKelvin = 1e6 / 600;
export const MaxTintMagnitude = 150;

type Vec3Tuple = readonly [number, number, number];

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function temperatureTintToXyz(temperatureKelvin: number, tint: number): Vec3Tuple {
    const temperature = Number.isNaN(temperatureKelvin) ? MinTemperatureKelvin : Math.max(temperatureKelvin, MinTemperatureKelvin);
    const mired = clamp(1e6 / temperature, 0, 600);

    let low = 0;
    let high = planckianLocus.length - 1;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (planckianLocus[middle]![0] <= mired) {
            low = middle;
        } else {
            high = middle;
        }
    }

    const [lowMired, lowU, lowV, lowSlope] = planckianLocus[low]!;
    const [highMired, highU, highV, highSlope] = planckianLocus[high]!;
    const interpolation = (mired - lowMired) / (highMired - lowMired);
    let u = lowU + (highU - lowU) * interpolation;
    let v = lowV + (highV - lowV) * interpolation;

    const lowLength = Math.hypot(1, lowSlope);
    const highLength = Math.hypot(1, highSlope);
    let isothermX = 1 / lowLength + (1 / highLength - 1 / lowLength) * interpolation;
    let isothermY = lowSlope / lowLength + (highSlope / highLength - lowSlope / lowLength) * interpolation;
    const isothermLength = Math.hypot(isothermX, isothermY);
    isothermX /= isothermLength;
    isothermY /= isothermLength;

    const tintOffset = clamp(tint, -MaxTintMagnitude, MaxTintMagnitude) / 3000;
    u -= isothermX * tintOffset;
    v -= isothermY * tintOffset;

    const denominator = 2 * u - 8 * v + 4;
    const x = (3 * u) / denominator;
    const y = (2 * v) / denominator;
    return [x / y, 1, (1 - x - y) / y];
}

function matrix(...values: number[]): Float32Array {
    return new Float32Array(values);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
    const result = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            result[row * 4 + column] = a[row * 4]! * b[column]! + a[row * 4 + 1]! * b[4 + column]! + a[row * 4 + 2]! * b[8 + column]! + a[row * 4 + 3]! * b[12 + column]!;
        }
    }
    return result;
}

function inverse(value: Float32Array): Float32Array {
    const result = invertMat4(value as unknown as Mat4);
    return result ? new Float32Array(result as unknown as ArrayLike<number>) : matrix(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

function transformNormal(value: Vec3Tuple, transform: Float32Array): Vec3Tuple {
    return [
        value[0] * transform[0]! + value[1] * transform[4]! + value[2] * transform[8]!,
        value[0] * transform[1]! + value[1] * transform[5]! + value[2] * transform[9]!,
        value[0] * transform[2]! + value[1] * transform[6]! + value[2] * transform[10]!,
    ];
}

function adaptationRatio(destination: number, source: number): number {
    return clamp(source > 0 ? destination / source : 10, 0.1, 10);
}

function adaptWhite(source: Vec3Tuple, destination: Vec3Tuple, bradford: Float32Array, inverseBradford: Float32Array): Float32Array {
    const sourceLms = transformNormal(source, bradford);
    const destinationLms = transformNormal(destination, bradford);
    const scale = matrix(
        adaptationRatio(destinationLms[0], sourceLms[0]),
        0,
        0,
        0,
        0,
        adaptationRatio(destinationLms[1], sourceLms[1]),
        0,
        0,
        0,
        0,
        adaptationRatio(destinationLms[2], sourceLms[2]),
        0,
        0,
        0,
        0,
        1
    );
    return multiply(multiply(bradford, scale), inverseBradford);
}

interface WhiteBalanceConstants {
    bradford: Float32Array;
    inverseBradford: Float32Array;
    rgbToXyz: Float32Array;
    xyzToRgb: Float32Array;
    referenceWhite: Vec3Tuple;
}

let whiteBalanceConstants: WhiteBalanceConstants | undefined;

function getWhiteBalanceConstants(): WhiteBalanceConstants {
    if (whiteBalanceConstants) {
        return whiteBalanceConstants;
    }

    const bradford = matrix(0.8951, -0.7502, 0.0389, 0, 0.2664, 1.7135, -0.0685, 0, -0.1614, 0.0367, 1.0296, 0, 0, 0, 0, 1);
    const inverseBradford = inverse(bradford);
    const standardRgbToXyz = matrix(0.4124564, 0.2126729, 0.0193339, 0, 0.3575761, 0.7151522, 0.119192, 0, 0.1804375, 0.072175, 0.9503041, 0, 0, 0, 0, 1);
    const rgbToXyz = multiply(standardRgbToXyz, adaptWhite([0.95047, 1, 1.08883], temperatureTintToXyz(6500, 0), bradford, inverseBradford));
    const xyzToRgb = inverse(rgbToXyz);
    const referenceWhite = transformNormal([1, 1, 1], rgbToXyz);
    return (whiteBalanceConstants = { bradford, inverseBradford, rgbToXyz, xyzToRgb, referenceWhite });
}

export function getWhiteBalanceMatrix(temperatureKelvin: number, tint: number): Float32Array {
    const constants = getWhiteBalanceConstants();
    const adapted = multiply(
        multiply(constants.rgbToXyz, adaptWhite(temperatureTintToXyz(temperatureKelvin, tint), constants.referenceWhite, constants.bradford, constants.inverseBradford)),
        constants.xyzToRgb
    );
    return new Float32Array([adapted[0]!, adapted[1]!, adapted[2]!, adapted[4]!, adapted[5]!, adapted[6]!, adapted[8]!, adapted[9]!, adapted[10]!]);
}
