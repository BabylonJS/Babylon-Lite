import { describe, expect, it } from "vitest";

import { createPerspectiveMat4LH } from "../../../packages/babylon-lite/src/math/create-perspective-mat4-lh";
import { parseSplatStreamManifest } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-meta";
import {
    extractStreamFrustumPlanes,
    planMergedStreamSelection,
    planStreamSelection,
    selectBootstrapSource,
    transformStreamBound,
} from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-selection";
import type { StreamManifest, StreamRepresentation, StreamSelectionInput, StreamSelectionPlan } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeManifest(): StreamManifest {
    return parseSplatStreamManifest(
        {
            version: 1,
            lodLevels: 2,
            lodErrors: true,
            filenames: ["broad/meta.json", "sparse/meta.json", "fine/meta.json"],
            tree: {
                bound: { min: [-0.8, -0.4, -0.8], max: [0.8, 0.4, -0.1] },
                children: [
                    {
                        bound: { min: [-0.8, -0.2, -0.4], max: [-0.2, 0.2, -0.1] },
                        lods: { "0": { file: 0, offset: 0, count: 1 }, "1": { file: 2, offset: 0, count: 2 } },
                        errors: [1, 0],
                    },
                    {
                        bound: { min: [-0.8, -0.2, -0.4], max: [-0.2, 0.2, -0.1] },
                        lods: { "0": { file: 0, offset: 1, count: 1 }, "1": { file: 2, offset: 2, count: 2 } },
                        errors: [1, 0],
                    },
                    {
                        bound: { min: [-0.1, -0.1, -0.8], max: [0.1, 0.1, -0.6] },
                        lods: { "0": { file: 1, offset: 0, count: 1 } },
                        errors: [0.5, 0],
                    },
                ],
            },
        },
        "https://assets.example/lod-meta.json"
    );
}

function input(parsed: StreamManifest, overrides: Partial<StreamSelectionInput> = {}): StreamSelectionInput {
    return {
        root: parsed.root,
        worldMatrix: IDENTITY,
        viewProjectionMatrix: IDENTITY,
        projectionP11: 1,
        cameraPosition: new Float32Array([0, 0, 0]),
        targetHeight: 100,
        near: 0.1,
        maxSplats: 10,
        screenError: 2,
        lodHysteresis: 0.15,
        ...overrides,
    };
}

describe("splat stream bounds and frustum", () => {
    it("extracts normalized WebGPU planes and excludes bounds outside clip z 0..1", () => {
        const planes = extractStreamFrustumPlanes(IDENTITY);
        expect(planes).toHaveLength(6);
        expect(planes[4]).toEqual({ x: 0, y: 0, z: 1, w: 0 });
        expect(planes[5]).toEqual({ x: 0, y: 0, z: -1, w: 1 });
    });

    it("transforms all eight corners under affine rotation, scale, and translation", () => {
        const parsed = makeManifest();
        const world = new Float32Array([0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
        const transformed = transformStreamBound(parsed.leaves[0]!, world);
        expect(Array.from(transformed.boundMin)).toEqual([4.400000095367432, 4.400000095367432, 7.400000095367432]);
        expect(Array.from(transformed.boundMax)).toEqual([5.599999904632568, 5.599999904632568, 8.600000381469727]);
        expect(transformed.radius).toBeCloseTo(Math.sqrt(1.08));
    });

    it("culls translated hierarchy branches before planning leaves", () => {
        const parsed = makeManifest();
        const translated = new Float32Array(IDENTITY);
        translated[12] = 3;
        const plan = planStreamSelection(input(parsed, { worldMatrix: translated }));
        expect(plan.visibleLeaves).toBe(0);
        expect(plan.selectedSplats).toBe(0);
    });

    it("culls fully behind bounds but preserves conservative near-plane intersections with a real perspective", () => {
        const parsed = parseSplatStreamManifest(
            {
                version: 1,
                lodLevels: 1,
                lodErrors: true,
                filenames: ["centered/meta.json"],
                tree: {
                    bound: { min: [-0.01, -0.01, -0.2], max: [0.01, 0.01, 0.2] },
                    lods: { "0": { file: 0, offset: 0, count: 1 } },
                    errors: [1],
                },
            },
            "https://assets.example/lod-meta.json"
        );
        const projection = createPerspectiveMat4LH(0.8, 1, 0.1, 100);
        const behind = new Float32Array(IDENTITY);
        behind[14] = -1;
        const culled = planStreamSelection(input(parsed, { worldMatrix: behind, viewProjectionMatrix: projection, projectionP11: projection[5]! }));
        expect(culled.visibleLeaves).toBe(0);
        expect(culled.selections).toEqual([]);

        const conservative = planStreamSelection(input(parsed, { viewProjectionMatrix: projection, projectionP11: projection[5]! }));
        expect(conservative.visibleLeaves).toBe(1);
        expect(conservative.selections.map((selection) => selection.leaf.id)).toEqual([0]);
    });
});

describe("splat stream selection planner", () => {
    it("starts from every visible coarse representation and upgrades nearest eligible bounds first", () => {
        const parsed = makeManifest();
        const plan = planStreamSelection(input(parsed, { maxSplats: 4 }));
        expect(plan.visibleLeaves).toBe(3);
        expect(plan.selectedSplats).toBe(4);
        expect(plan.selections.map((selection) => [selection.leaf.id, selection.target.lod])).toEqual([
            [0, 1],
            [1, 0],
            [2, 0],
        ]);
    });

    it("responds to projection scale and resize through the pixel error proxy", () => {
        const parsed = makeManifest();
        const small = planStreamSelection(input(parsed, { targetHeight: 2, screenError: 2 }));
        const large = planStreamSelection(input(parsed, { targetHeight: 100, screenError: 2 }));
        expect(small.selections.map((selection) => selection.target.lod)).toEqual([0, 0, 0]);
        expect(large.selections.map((selection) => selection.target.lod)).toEqual([1, 1, 0]);
    });

    it("keeps a previous target inside the hysteresis band and crosses both thresholds", () => {
        const parsed = makeManifest();
        const coarse = parsed.leaves[0]!.alternatives[0]!;
        const previousCoarse = new Map<number, StreamRepresentation>([[0, coarse]]);
        const blockedUpgrade = planStreamSelection(input(parsed, { targetHeight: 3.3, screenError: 1, previousTargets: previousCoarse }));
        expect(blockedUpgrade.selections[0]!.target.lod).toBe(0);
        const upgraded = planStreamSelection(input(parsed, { targetHeight: 4, screenError: 1, previousTargets: previousCoarse }));
        expect(upgraded.selections[0]!.target.lod).toBe(1);

        const fine = parsed.leaves[0]!.alternatives[1]!;
        const previousFine = new Map<number, StreamRepresentation>([[0, fine]]);
        const preserved = planStreamSelection(input(parsed, { targetHeight: 3.7, screenError: 1, previousTargets: previousFine }));
        expect(preserved.selections[0]!.target.lod).toBe(1);
        const downgraded = planStreamSelection(input(parsed, { targetHeight: 2, screenError: 1, previousTargets: previousFine }));
        expect(downgraded.selections[0]!.target.lod).toBe(0);
    });

    it("reallocates a saturated budget to the newly nearest volume without history lock", () => {
        const parsed = parseSplatStreamManifest(
            {
                version: 1,
                lodLevels: 2,
                lodErrors: true,
                filenames: ["fine/meta.json", "coarse/meta.json"],
                tree: {
                    bound: { min: [-3.4, -0.4, -3.4], max: [3.4, 0.4, -2.6] },
                    children: [
                        {
                            bound: { min: [-3.4, -0.4, -3.4], max: [-2.6, 0.4, -2.6] },
                            lods: { "0": { file: 0, offset: 0, count: 100 }, "1": { file: 1, offset: 0, count: 10 } },
                            errors: [0, 1],
                        },
                        {
                            bound: { min: [2.6, -0.4, -3.4], max: [3.4, 0.4, -2.6] },
                            lods: { "0": { file: 0, offset: 100, count: 100 }, "1": { file: 1, offset: 10, count: 10 } },
                            errors: [0, 1],
                        },
                    ],
                },
            },
            "https://assets.example/lod-meta.json"
        );
        const projection = createPerspectiveMat4LH(2.6, 1, 0.1, 100);
        const at = (cameraX: number, previousTargets?: ReadonlyMap<number, StreamRepresentation>, lodHysteresis = 0.15) => {
            const viewProjection = new Float32Array(projection);
            viewProjection[12] = -projection[0]! * cameraX;
            return planStreamSelection(
                input(parsed, {
                    viewProjectionMatrix: viewProjection,
                    projectionP11: projection[5]!,
                    cameraPosition: [cameraX, 0, 0],
                    targetHeight: 1000,
                    maxSplats: 110,
                    screenError: 2,
                    previousTargets,
                    lodHysteresis,
                })
            );
        };
        const left = at(-3);
        expect(left.selections.map((selection) => selection.target.lod)).toEqual([0, 1]);
        const previous = new Map(left.selections.map((selection) => [selection.leaf.id, selection.target] as const));
        expect(at(3, previous).selections.map((selection) => selection.target.lod)).toEqual([1, 0]);
        expect(at(3, previous, 0).selections.map((selection) => selection.target.lod)).toEqual([1, 0]);
    });

    it("prioritizes a nearer expensive upgrade over a farther cheap upgrade", () => {
        const parsed = parseSplatStreamManifest(
            {
                version: 1,
                lodLevels: 2,
                lodErrors: true,
                filenames: ["fine/meta.json", "coarse/meta.json"],
                tree: {
                    bound: { min: [-0.4, -0.4, -3.4], max: [5.4, 0.4, -2.6] },
                    children: [
                        {
                            bound: { min: [-0.4, -0.4, -3.4], max: [0.4, 0.4, -2.6] },
                            lods: { "0": { file: 0, offset: 0, count: 100 }, "1": { file: 1, offset: 0, count: 10 } },
                            errors: [0, 1],
                        },
                        {
                            bound: { min: [4.6, -0.4, -3.4], max: [5.4, 0.4, -2.6] },
                            lods: { "0": { file: 0, offset: 100, count: 20 }, "1": { file: 1, offset: 10, count: 10 } },
                            errors: [0, 1],
                        },
                    ],
                },
            },
            "https://assets.example/lod-meta.json"
        );
        const projection = createPerspectiveMat4LH(2.6, 1, 0.1, 100);
        const plan = planStreamSelection(
            input(parsed, {
                viewProjectionMatrix: projection,
                projectionP11: projection[5]!,
                cameraPosition: [0, 0, 0],
                targetHeight: 1000,
                maxSplats: 110,
                screenError: 2,
            })
        );
        expect(plan.selections.map((selection) => selection.target.lod)).toEqual([0, 1]);
    });

    it("downgrades immediately under hard pressure and fails rather than dropping visible leaves", () => {
        const parsed = makeManifest();
        const previous = new Map(parsed.leaves.slice(0, 2).map((leaf) => [leaf.id, leaf.alternatives[1]!] as const));
        const pressured = planStreamSelection(input(parsed, { maxSplats: 3, previousTargets: previous, hardBudgetPressure: true }));
        expect(pressured.selectedSplats).toBe(3);
        expect(pressured.selections.every((selection) => selection.target.lod === 0)).toBe(true);
        expect(() => planStreamSelection(input(parsed, { maxSplats: 2 }))).toThrow("visible coarse baseline");
    });

    it("solves disjoint camera demand once against the shared capacity", () => {
        const parsed = parseSplatStreamManifest(
            {
                version: 1,
                lodLevels: 2,
                lodErrors: true,
                filenames: ["coarse/meta.json", "fine/meta.json"],
                tree: {
                    bound: { min: [-2, -1, -2], max: [2, 1, -1] },
                    children: [
                        {
                            bound: { min: [-2, -1, -2], max: [-1, 1, -1] },
                            lods: { "0": { file: 0, offset: 0, count: 20 }, "1": { file: 1, offset: 0, count: 70 } },
                            errors: [1, 0],
                        },
                        {
                            bound: { min: [1, -1, -2], max: [2, 1, -1] },
                            lods: { "0": { file: 0, offset: 20, count: 40 }, "1": { file: 1, offset: 70, count: 70 } },
                            errors: [1, 0],
                        },
                    ],
                },
            },
            "https://assets.example/lod-meta.json"
        );
        const cameraPlan = (leafIndex: number, distanceToCamera: number): StreamSelectionPlan => {
            const leaf = parsed.leaves[leafIndex]!;
            const target = leaf.alternatives[1]!;
            return {
                selections: [{ leaf, target, projectedError: 0, projectedRadius: 100, distanceToCamera }],
                visibleLeaves: 1,
                selectedSplats: target.count,
            };
        };
        const plan = planMergedStreamSelection([cameraPlan(0, 10), cameraPlan(1, 1)], 100, 2, 0.15);
        expect(plan.selectedSplats).toBe(90);
        expect(plan.selections.map((selection) => selection.target.count)).toEqual([20, 70]);
    });

    it("supports cameras inside bounds and rejects orthographic planning explicitly", () => {
        const parsed = makeManifest();
        const plan = planStreamSelection(input(parsed, { cameraPosition: [-0.5, 0, 0.2], maxSplats: 3 }));
        expect(plan.visibleLeaves).toBe(3);
        expect(plan.selections[0]!.projectedError).toBeGreaterThan(0);
        expect(() => planStreamSelection(input(parsed, { perspective: false }))).toThrow("orthographic");
    });
});

describe("bootstrap source aggregation", () => {
    it("chooses broad leaf coverage before splat count or file order", () => {
        const parsed = makeManifest();
        expect(selectBootstrapSource(parsed.leaves, parsed.sources).url).toBe("https://assets.example/broad/meta.json");
    });

    it("breaks equal coverage by aggregate splats then stable source ID", () => {
        const parsed = parseSplatStreamManifest(
            {
                version: 1,
                lodLevels: 1,
                filenames: ["large/meta.json", "small/meta.json", "equal/meta.json"],
                tree: {
                    bound: { min: [-1, -1, -1], max: [1, 1, 1] },
                    children: [
                        { bound: { min: [-1, -1, -1], max: [0, 0, 0] }, lods: { "0": { file: 0, offset: 0, count: 10 } } },
                        { bound: { min: [0, 0, 0], max: [1, 1, 1] }, lods: { "0": { file: 1, offset: 0, count: 2 } } },
                    ],
                },
            },
            "https://assets.example/lod-meta.json"
        );
        expect(selectBootstrapSource(parsed.leaves, parsed.sources).id).toBe(1);
    });
});
