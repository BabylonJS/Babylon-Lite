import { GAME_SCALE } from "./constants.js";
import type { LayoutEntry, PuzzleFamily, Vec3Tuple } from "./types.js";

const d = (points: readonly Vec3Tuple[], samples: number): LayoutEntry => ({ family: "domino", points, values: [samples] });
const cup = (points: readonly Vec3Tuple[], samples: number): LayoutEntry => ({ family: "cup", points, values: [samples] });
const stack = (point: Vec3Tuple, width: number, height: number, depth: number): LayoutEntry => ({ family: "cubeStack", points: [point], values: [width, height, depth] });
const arch = (point: Vec3Tuple, direction: Vec3Tuple, count: number, height: number): LayoutEntry => ({ family: "arch", points: [point], direction, values: [count, height] });
const pathCubes = (points: readonly Vec3Tuple[], samples: number, height: number): LayoutEntry => ({ family: "cubes", points, values: [samples, height] });

const dominoes: LayoutEntry[] = [
    d(
        [
            [-5, 0, -15],
            [-2, 0, -25],
            [5, 0, -28.25],
            [22, 0, -48],
            [40, 0, -30],
            [55, 0, -28],
            [70, 0, -35],
            [82, 0, -40],
            [80, 0, -30],
            [77, 0, -10],
            [75, 0, 10],
            [45, 0, 20],
            [41, 0, 30],
        ],
        12
    ),
    d(
        [
            [26, 0, 28],
            [31, 0, 37],
        ],
        8
    ),
    d(
        [
            [31.75, 0, 37.25],
            [35, 0, 37],
            [27, 0, 27],
            [35, 0, 20],
            [38, 0, 20],
            [38, 0, 30],
        ],
        10
    ),
    d(
        [
            [46, 0, 34],
            [45.75, 0, 36],
        ],
        2
    ),
    d(
        [
            [31, 0, 37.65],
            [33, 0, 41],
            [28, 0, 42],
            [23, 0, 35],
        ],
        8
    ),
    d(
        [
            [24.5, 0, 38.75],
            [23, 0, 34],
            [21, 0, 34.75],
            [21, 0, 39],
        ],
        8
    ),
    d(
        [
            [20.5, 0, 48.9],
            [19.5, 0, 53],
            [19, 0, 57],
            [17, 0, 60],
            [12, 0, 60],
            [8, 0, 59],
            [5, 0, 58],
            [6, 0, 53],
            [6, 0, 49],
            [10, 0, 46],
            [11.75, 0, 43],
        ],
        6
    ),
    d(
        [
            [5.15, 0, 49.25],
            [4, 0, 46],
            [1, 0, 46],
            [-1.5, 0, 46],
            [-2, 0, 43.75],
        ],
        5
    ),
    d(
        [
            [20, 0, 40.5],
            [23, 0, 55],
            [35, 0, 50],
            [48, 0, 51],
        ],
        15
    ),
    d(
        [
            [-31, 0, -29],
            [-40, 0, -35],
            [-50, 0, -32],
            [-57, 0, -42],
            [-65, 0, -34],
            [-69.5, 0, -25],
            [-64.75, 0, -19.5],
        ],
        12
    ),
    d(
        [
            [-42.15, 0, -35],
            [-47, 0, -36],
            [-45, 0, -45],
            [-38, 0, -55],
            [-30, 0, -50],
            [-28, 0, -40],
            [-26, 0, -39.25],
        ],
        12
    ),
    d(
        [
            [-27.25, 0, -38.5],
            [-25.5, 0, -39.5],
        ],
        3
    ),
];

const cups: LayoutEntry[] = [
    cup(
        [
            [68, 2, 22],
            [64, 2, 32],
        ],
        5
    ),
    cup(
        [
            [70, 2, 16],
            [70, 2, 30],
            [60, 2, 40],
        ],
        6
    ),
    cup(
        [
            [18, 0, 35],
            [16, 0, 45],
            [8, 0, 50],
        ],
        4
    ),
    cup(
        [
            [-10, 0, 35],
            [-8, 0, 45],
            [0, 0, 50],
        ],
        4
    ),
    cup(
        [
            [-35, 0, 8],
            [-35, 0, -8],
        ],
        8
    ),
    cup(
        [
            [-32, 0, 6],
            [-32, 0, -6],
        ],
        6
    ),
    cup(
        [
            [-29, 0, 4],
            [-29, 0, -4],
        ],
        4
    ),
    cup(
        [
            [-26, 0, 2],
            [-26, 0, -2],
        ],
        2
    ),
    cup(
        [
            [10, 0, 10],
            [5, 0, 12],
        ],
        2
    ),
];

const cubeStacks: LayoutEntry[] = [
    stack([-5.5, 0, 38], 2, 10, 2),
    stack([0, 0, 35], 4, 4, 4),
    stack([2.6, 10, 37.75], 2, 3, 2),
    stack([4, 17.5, 39.25], 1, 7, 1),
    stack([11, 0, 38], 2, 10, 2),
    stack([12, 0, 35], 1, 3, 1),
    stack([-4, 0, 35.25], 1, 2, 1),
    stack([52, 0, 52], 1, 4, 1),
    stack([54.5, 0, 52], 1, 7, 1),
    stack([52, 0, 54.5], 1, 5, 1),
    stack([54.5, 0, 54.5], 1, 6, 1),
    stack([57, 0, 52], 2, 6, 3),
    stack([58.5, 15, 54.5], 1, 2, 1),
    stack([62.5, 0, 52], 3, 10, 3),
    stack([65, 25, 54.5], 1, 3, 1),
    stack([54.5, 0, 49.5], 1, 3, 1),
    stack([57, 0, 49.5], 1, 2, 1),
    stack([-38, 0, -40], 1, 7, 1),
    stack([-31, 0, -44], 1, 8, 1),
    stack([43, 0, 40], 1, 8, 1),
    stack([43, 0, 34], 1, 8, 1),
    stack([49, 0, 40], 1, 8, 1),
    stack([49, 0, 34], 1, 8, 1),
    stack([-58, 0, -25], 8, 1, 8),
    stack([-56.75, 2.5, -23.75], 7, 1, 7),
    stack([-55.5, 5, -22.5], 6, 1, 6),
    stack([-54.25, 7.5, -21.25], 5, 1, 5),
    stack([-53, 10, -20], 4, 1, 4),
    stack([-51.75, 12.5, -18.75], 3, 1, 3),
    stack([-50.5, 15, -17.5], 2, 1, 2),
    stack([-49.25, 17.5, -16.25], 1, 1, 1),
    stack([0, 0, -25], 3, 3, 3),
    stack([0, 7.5, -25], 2, 2, 2),
    stack([0, 12.5, -25], 1, 1, 2),
    stack([2.5, 12.5, -25], 1, 1, 1),
    stack([1.25, 15, -23.75], 1, 3, 1),
    stack([63.5, 0, 25], 1, 2, 1),
    stack([-16, 0, 24], 2, 4, 2),
    stack([-16, 10, 26.65], 2, 3, 1),
    stack([-16, 10, 24], 1, 3, 1),
    stack([-16, 17.5, 26.65], 1, 3, 1),
];

const cubePaths: LayoutEntry[] = [
    pathCubes(
        [
            [-30, 0, -15],
            [-30, 0, -32],
            [-24, 0, -50],
        ],
        2,
        5
    ),
    pathCubes(
        [
            [-21.5, 0, -27],
            [-22, 0, -50],
            [-10, 0, -60],
        ],
        5,
        4
    ),
    pathCubes(
        [
            [-12, 0, -13],
            [-5, 0, -30],
            [10, 0, -45],
            [25, 0, -35],
        ],
        5,
        3
    ),
    pathCubes(
        [
            [-24, 0, 28],
            [-16, 0, 34],
            [-8, 0, 25],
            [-16, 0, 16],
            [-27, 0, 11],
        ],
        2,
        3
    ),
];

const arches: LayoutEntry[] = [
    arch([56, 0, -50], [0, 0, 1], 3, 4),
    arch([77, 0, -48], [0.35, 0, 1], 1, 6),
    arch([77, 0, -43], [-0.25, 0, 1], 1, 5),
    arch([74, 0, -54], [0.5, 0, 1], 1, 4),
    arch([30, 0, 30], [-1, 0, 0.5], 1, 4),
    arch([36, 0, 30], [-1, 0, 0.5], 3, 6),
    arch([25, 0, -7.5], [0, 0, 1], 3, 6),
    arch([23, 0, -4.25], [0, 0, 1], 2, 4),
    arch([21, 0, -1.25], [0, 0, 1], 1, 3),
    arch([-40, 0, 10], [1, 0, 1], 3, 7),
    arch([-36, 0, 17], [1, 0, -1], 1, 5),
    arch([-31, 0, 21], [1, 0, -1], 1, 5),
    arch([-40, 0, 13], [1, 0, -1], 1, 5),
    arch([-33, 0, 10], [1, 0, 1], 2, 4),
    arch([10, 0, -10], [-1, 0, -0.5], 1, 3),
];

const popperPoints: readonly Vec3Tuple[] = [
    [61.3, 0.25, 24],
    [-30, 0.25, 28],
    [50.5, 0.25, 50.5],
    [11, 0.25, 43],
    [-2, 0.25, 43],
    [45.7, 0.25, 37.2],
    [-60, 0.25, -15.5],
    [-58.75, 2.75, -15.5],
    [-57.5, 5.25, -15.5],
    [-56.25, 7.75, -15.5],
    [-55, 10.25, -15.5],
    [-53.75, 12.75, -15.5],
    [-52.5, 15.25, -15.5],
    [1.75, 12.75, -23.25],
    [-18, 0.25, 25],
    [-25, 0.25, -40],
];

export const PLAYROOM_LAYOUT: readonly LayoutEntry[] = [
    ...dominoes,
    { family: "stack", points: [[40, 0, -10]], values: [10] },
    { family: "tower", points: [[-33, 0, 33]] },
    ...cups,
    { family: "bowlingBall", points: [[24, 7, -25]] },
    { family: "bowlingPins", points: [[50, 0, -25]], direction: [1, 0, 0], values: [6] },
    { family: "ramp", points: [[28, 0.1, -25]], values: [0] },
    ...cubeStacks,
    ...cubePaths,
    ...arches,
    ...popperPoints.map((point, index): LayoutEntry => ({ family: "popper", points: [point], strong: index === 0 || index === 2 })),
    { family: "chess", points: [[46, 20.6, 37]] },
];

export function countLayoutFamilies(layout: readonly LayoutEntry[] = PLAYROOM_LAYOUT): Readonly<Record<PuzzleFamily, number>> {
    const counts = {
        domino: 0,
        stack: 0,
        tower: 0,
        cup: 0,
        bowlingBall: 0,
        bowlingPins: 0,
        ramp: 0,
        cubeStack: 0,
        cubes: 0,
        arch: 0,
        popper: 0,
        chess: 0,
    };
    for (const entry of layout) {
        counts[entry.family]++;
    }
    return counts;
}

export function scaledPoint(point: Vec3Tuple): [number, number, number] {
    return [-point[0] * GAME_SCALE, point[1] * GAME_SCALE, point[2] * GAME_SCALE];
}
