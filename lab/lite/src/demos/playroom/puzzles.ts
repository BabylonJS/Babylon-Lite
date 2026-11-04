import { GAME_SCALE } from "./constants.js";
import { scaledPoint } from "./layout.js";
import type { LayoutEntry, PuzzleFamily, Vec3Tuple } from "./types.js";

export interface PuzzleBatch {
    readonly family: PuzzleFamily;
    readonly model: string;
    readonly matrices: Float32Array;
    readonly colors?: Float32Array;
    readonly shape: "box" | "sphere" | "cylinder" | "convex" | "mesh" | "arch";
    readonly mass: number;
    readonly friction: number;
    readonly restitution: number;
}

const CUBE_COLORS = [
    [0.906, 0.141, 0.278],
    [0.82, 0.208, 0.71],
    [0.086, 0.733, 0.533],
    [0.078, 0.514, 0.957],
    [0.463, 0.306, 0.678],
    [0.992, 0.424, 0.035],
    [0.812, 0.933, 0.255],
] as const;

const ARCH_COLORS = [
    [0.129, 0.545, 0.51],
    [0.604, 0.851, 0.859],
    [0.898, 0.859, 0.851],
    [0.596, 0.831, 0.733],
    [0.922, 0.588, 0.667],
] as const;

export type PuzzleRandom = () => number;

export interface PuzzleTemplateBounds {
    readonly [model: string]: {
        readonly collisionBounds: {
            readonly center: Vec3Tuple;
            readonly extents: Vec3Tuple;
        };
    };
}

export function createPuzzleRandom(seed: number): PuzzleRandom {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function matrix(x: number, y: number, z: number, yaw = 0, pitch = 0): number[] {
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    const qx = sp * cy;
    const qy = cp * sy;
    const qz = -sp * sy;
    const qw = cp * cy;
    const xx = qx * qx;
    const yy = qy * qy;
    const zz = qz * qz;
    const xy = qx * qy;
    const xz = qx * qz;
    const yz = qy * qz;
    const wx = qw * qx;
    const wy = qw * qy;
    const wz = qw * qz;
    return [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0, 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0, 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0, x, y, z, 1];
}

function slab(matrices: readonly number[][]): Float32Array {
    const out = new Float32Array(matrices.length * 16);
    for (let i = 0; i < matrices.length; i++) {
        out.set(matrices[i]!, i * 16);
    }
    return out;
}

function colors(count: number, palette: readonly (readonly [number, number, number])[], rng: () => number): Float32Array {
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        writeColor(out, i, palette, rng);
    }
    return out;
}

function writeColor(out: Float32Array, index: number, palette: readonly (readonly [number, number, number])[], rng: PuzzleRandom): void {
    const color = palette[Math.floor(rng() * palette.length)]!;
    out.set([color[0], color[1], color[2], 1], index * 4);
}

function catmullRom(points: readonly Vec3Tuple[], samplesPerSegment: number): [number, number, number][] {
    const p = points.map(scaledPoint);
    if (p.length < 2) {
        return p;
    }
    const result: [number, number, number][] = [];
    for (let segment = 0; segment < p.length - 1; segment++) {
        const p0 = p[Math.max(0, segment - 1)]!;
        const p1 = p[segment]!;
        const p2 = p[segment + 1]!;
        const p3 = p[Math.min(p.length - 1, segment + 2)]!;
        const first = segment === 0 ? 0 : 1;
        for (let step = first; step <= samplesPerSegment; step++) {
            const t = step / samplesPerSegment;
            const t2 = t * t;
            const t3 = t2 * t;
            const point: [number, number, number] = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
                point[axis] =
                    0.5 *
                    (2 * p1[axis]! +
                        (-p0[axis]! + p2[axis]!) * t +
                        (2 * p0[axis]! - 5 * p1[axis]! + 4 * p2[axis]! - p3[axis]!) * t2 +
                        (-p0[axis]! + 3 * p1[axis]! - 3 * p2[axis]! + p3[axis]!) * t3);
            }
            result.push(point);
        }
    }
    return spreadPoints(result);
}

function spreadPoints(points: readonly [number, number, number][]): [number, number, number][] {
    if (points.length < 2) {
        return points.slice();
    }
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1], points[i]![2] - points[i - 1]![2]);
    }
    const distance = total / (points.length - 1);
    const out: [number, number, number][] = [[...points[0]!]];
    for (let i = 1; i < points.length; i++) {
        const sourceA = points[i - 1]!;
        const sourceB = points[i]!;
        const length = Math.max(1e-8, Math.hypot(sourceB[0] - sourceA[0], sourceB[1] - sourceA[1], sourceB[2] - sourceA[2]));
        const previous = out[i - 1]!;
        out.push([
            previous[0] + ((sourceB[0] - sourceA[0]) / length) * distance,
            previous[1] + ((sourceB[1] - sourceA[1]) / length) * distance,
            previous[2] + ((sourceB[2] - sourceA[2]) / length) * distance,
        ]);
    }
    return out;
}

function batch(
    family: PuzzleFamily,
    model: string,
    matrices: number[][],
    shape: PuzzleBatch["shape"],
    mass = GAME_SCALE ** 3,
    friction = 0.2,
    restitution = 0.3,
    colorData?: Float32Array
): PuzzleBatch {
    return { family, model, matrices: slab(matrices), colors: colorData, shape, mass, friction, restitution };
}

function bounds(templates: PuzzleTemplateBounds, model: string): PuzzleTemplateBounds[string]["collisionBounds"] {
    const result = templates[model]?.collisionBounds;
    if (!result) {
        throw new Error(`The Playroom cannot expand placements without baked bounds for ${model}.`);
    }
    return result;
}

export function expandPuzzle(entry: LayoutEntry, rng: PuzzleRandom, templates: PuzzleTemplateBounds): PuzzleBatch[] {
    const point = scaledPoint(entry.points[0]!);
    switch (entry.family) {
        case "domino": {
            const points = catmullRom(entry.points, entry.values![0]!);
            const matrices = points.map((p, i) => {
                const next = points[1]!;
                const prev: Vec3Tuple = i === 0 ? [2 * p[0]! - next[0]!, 2 * p[1]! - next[1]!, 2 * p[2]! - next[2]!] : points[i - 1]!;
                return matrix(p[0], p[1] + 0.05, p[2], Math.atan2(p[0] - prev[0], p[2] - prev[2]));
            });
            return [batch("domino", "domino", matrices, "box")];
        }
        case "stack": {
            const matrices: number[][] = [];
            const height = entry.values![0]!;
            for (let level = 0; level < height; level++) {
                for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
                    const sourceYaw = (rng() * 0.5 - 0.5) * 2 * 0.2 + (level & 1 ? 0 : Math.PI / 2);
                    const side = sideIndex * 2 - 1;
                    let sourceDx = level & 1 ? 3.5 * side : 0;
                    let sourceDz = level & 1 ? 0 : 3.5 * side;
                    sourceDx += (rng() * 0.5 - 0.5) * 2 * 0.5;
                    sourceDz += (rng() * 0.5 - 0.5) * 2 * 0.5;
                    matrices.push(matrix(point[0] - sourceDx * GAME_SCALE, point[1] + level * 1.5 * GAME_SCALE + 0.05, point[2] + sourceDz * GAME_SCALE, -sourceYaw));
                }
            }
            return [batch("stack", "towerGameBlock", matrices, "box")];
        }
        case "tower": {
            const matrices: number[][] = [];
            const blockHeight = 7.5 * GAME_SCALE;
            const blockWidth = 1.5 * GAME_SCALE;
            const relativeRadius = 0.9;
            const innerRadiusAdjustment = 0.8;
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const sourceX = Math.sin(angle);
                const sourceZ = Math.cos(angle);
                matrices.push(matrix(point[0] - sourceX * blockHeight, point[1] + blockHeight / 2 + 0.05, point[2] + sourceZ * blockHeight, -angle));
                matrices.push(
                    matrix(
                        point[0] - sourceX * blockHeight * relativeRadius * 0.5,
                        point[1] + blockHeight / 2 + 0.05,
                        point[2] + sourceZ * blockHeight * relativeRadius * 0.5,
                        -angle
                    )
                );
                matrices.push(
                    matrix(
                        point[0] - sourceX * blockHeight * relativeRadius,
                        point[1] + blockHeight + blockWidth * 0.5 + 0.05,
                        point[2] + sourceZ * blockHeight * relativeRadius,
                        -angle,
                        Math.PI / 2
                    )
                );
                matrices.push(
                    matrix(
                        point[0] - sourceX * blockHeight * relativeRadius,
                        point[1] + 1.5 * blockHeight + blockWidth * 2 + 0.05,
                        point[2] + sourceZ * blockHeight * relativeRadius,
                        -angle
                    )
                );
                if ((i & 1) === 0) {
                    const mid = ((2 * i + 1) / 12) * Math.PI * 2;
                    const midX = Math.sin(mid) * blockHeight * relativeRadius * innerRadiusAdjustment;
                    const midZ = Math.cos(mid) * blockHeight * relativeRadius * innerRadiusAdjustment;
                    matrices.push(matrix(point[0] - midX, point[1] + blockHeight + blockWidth * 1.5 + 0.05, point[2] + midZ, -mid - Math.PI / 2, Math.PI / 2));
                    matrices.push(matrix(point[0] - midX, point[1] + 1.5 * blockHeight + blockWidth * 2 + 0.05, point[2] + midZ, -angle - Math.PI / 2));
                    matrices.push(matrix(point[0] - midX, point[1] + 2 * blockHeight + blockWidth * 2.5 + 0.05, point[2] + midZ, -mid, Math.PI / 2));
                }
            }
            return [batch("tower", "transformedTowerGameBlock", matrices, "box")];
        }
        case "cup": {
            const points = catmullRom(entry.points, entry.values![0]!);
            const mids = points
                .slice(0, -1)
                .map((p, i): [number, number, number] => [(p[0] + points[i + 1]![0]) / 2, (p[1] + points[i + 1]![1]) / 2, (p[2] + points[i + 1]![2]) / 2]);
            const matrices: number[][] = [];
            const cupHalfHeight = bounds(templates, "cup").extents[1] * 0.5;
            for (let level = 0; level < points.length; level++) {
                const source = level & 1 ? mids : points;
                const offset = Math.floor(level / 2);
                for (let i = offset; i < source.length - offset; i++) {
                    const p = source[i]!;
                    matrices.push(matrix(p[0], cupHalfHeight * 2.011 * (level + 1) + 0.05, p[2], 0, Math.PI));
                }
            }
            return [batch("cup", "cup", matrices, "convex", 0.5 * GAME_SCALE ** 3, 1, 0)];
        }
        case "bowlingBall":
            return [batch("bowlingBall", "bowlingBall", [matrix(point[0], point[1], point[2])], "sphere", 200 * GAME_SCALE ** 3, 0.9, 0)];
        case "bowlingPins": {
            const direction = entry.direction!;
            const right: Vec3Tuple = [-direction[2], 0, direction[0]];
            const matrices: number[][] = [];
            for (let row = 0; row < entry.values![0]!; row++) {
                for (let column = 0; column <= row; column++) {
                    matrices.push(
                        matrix(
                            point[0] - (direction[0] * row + right[0] * (column - row * 0.5)) * 3 * GAME_SCALE,
                            point[1] + 0.101,
                            point[2] + (direction[2] * row + right[2] * (column - row * 0.5)) * 3 * GAME_SCALE
                        )
                    );
                }
            }
            return [batch("bowlingPins", "bowlingPin", matrices, "convex")];
        }
        case "ramp":
            return [batch("ramp", "ramp", [matrix(point[0], point[1], point[2], -(entry.values![0]! / 180) * Math.PI)], "mesh", 100 * GAME_SCALE ** 3, 0.9, 0)];
        case "cubeStack": {
            const [width, height, depth] = entry.values!;
            const cubeBounds = bounds(templates, "cube");
            const cubeMinY = cubeBounds.center[1] - cubeBounds.extents[1] * 0.5;
            const cubeHalfHeight = cubeBounds.extents[1] * 0.5;
            const matrices: number[][] = [];
            for (let x = 0; x < width!; x++) {
                for (let y = 0; y < height!; y++) {
                    for (let z = 0; z < depth!; z++) {
                        matrices.push(matrix(point[0] - x * 2.7 * GAME_SCALE, point[1] + y * cubeHalfHeight * 2.001 - cubeMinY + 0.05, point[2] + z * 2.7 * GAME_SCALE));
                    }
                }
            }
            return [batch("cubeStack", "cube", matrices, "box", GAME_SCALE ** 3, 0.2, 0.3, colors(matrices.length, CUBE_COLORS, rng))];
        }
        case "cubes": {
            const points = catmullRom(entry.points, entry.values![0]!);
            const matrices: number[][] = [];
            const colorData = new Float32Array(points.length * entry.values![1]! * 4);
            const cubeBounds = bounds(templates, "cube");
            const cubeMinY = cubeBounds.center[1] - cubeBounds.extents[1] * 0.5;
            const cubeHalfHeight = cubeBounds.extents[1] * 0.5;
            let previous = points[1]!;
            for (const p of points) {
                for (let level = 0; level < entry.values![1]!; level++) {
                    const yaw = Math.atan2(p[0] - previous[0], p[2] - previous[2]) - (rng() * 0.4 - 0.2);
                    matrices.push(matrix(p[0], p[1] + level * cubeHalfHeight * 2 - cubeMinY + 0.05, p[2], yaw));
                    writeColor(colorData, matrices.length - 1, CUBE_COLORS, rng);
                }
                previous = p;
            }
            return [batch("cubes", "cube", matrices, "box", GAME_SCALE ** 3, 0.2, 0.3, colorData)];
        }
        case "arch": {
            const [count, height] = entry.values!;
            const directionLength = Math.hypot(entry.direction![0], entry.direction![2]);
            const direction: Vec3Tuple = [entry.direction![0] / directionLength, 0, entry.direction![2] / directionLength];
            const columns: number[][] = [];
            const arches: number[][] = [];
            const tops: number[][] = [];
            const columnColors = new Float32Array(count! * Math.max(0, height! - 2) * 2 * 4);
            const archColors = new Float32Array(count! * 4);
            const topColors = new Float32Array(count! * 4);
            const cylinderBounds = bounds(templates, "archCylinder");
            const cylinderMinY = cylinderBounds.center[1] - cylinderBounds.extents[1] * 0.5;
            const cylinderHalfHeight = cylinderBounds.extents[1] * 0.5;
            const archHalfHeight = bounds(templates, "arch").extents[1] * 0.5;
            const yaw = -Math.atan2(direction[0], direction[2]) - Math.PI / 2;
            for (let i = 0; i < count!; i++) {
                for (let level = 0; level < height! - 2; level++) {
                    for (let side = 0; side < 2; side++) {
                        columns.push(
                            matrix(
                                point[0] - direction[0] * (i * 6 + side * 4) * GAME_SCALE,
                                point[1] + level * cylinderHalfHeight * 2 - cylinderMinY + 0.05,
                                point[2] + direction[2] * (i * 6 + side * 4) * GAME_SCALE
                            )
                        );
                        writeColor(columnColors, columns.length - 1, ARCH_COLORS, rng);
                    }
                }
                const x = point[0] - direction[0] * (2 + i * 6) * GAME_SCALE;
                const z = point[2] + direction[2] * (2 + i * 6) * GAME_SCALE;
                const y = point[1] + (height! - 2) * cylinderHalfHeight * 2 - cylinderMinY + 0.05;
                arches.push(matrix(x, y, z, yaw));
                writeColor(archColors, arches.length - 1, ARCH_COLORS, rng);
                tops.push(matrix(x, y + archHalfHeight * 2, z, yaw));
                writeColor(topColors, tops.length - 1, ARCH_COLORS, rng);
            }
            return [
                batch("arch", "archCylinder", columns, "cylinder", GAME_SCALE ** 3, 0.2, 0.3, columnColors),
                batch("arch", "arch", arches, "arch", GAME_SCALE ** 3, 0.2, 0.3, archColors),
                batch("arch", "archTop", tops, "convex", GAME_SCALE ** 3, 0.2, 0.3, topColors),
            ];
        }
        case "popper":
            return [batch("popper", "popper", [matrix(point[0], point[1], point[2])], "box")];
        case "chess": {
            const board = batch("chess", "chessboard", [matrix(point[0], point[1], point[2])], "box");
            const white: number[][] = [];
            const black: number[][] = [];
            for (let row = 0; row < 8; row++) {
                const target = row < 2 ? white : row >= 6 ? black : null;
                if (!target) {
                    continue;
                }
                for (let column = 0; column < 8; column++) {
                    target.push(matrix(point[0] + (column - 4) * 0.12, point[1] + 0.04, point[2] - (row - 4) * 0.12));
                }
            }
            return [board, batch("chess", "chessBlack", black, "convex"), batch("chess", "chessWhite", white, "convex")];
        }
    }
}
