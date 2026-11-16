import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Fixture {
    readonly schemaVersion: number;
    readonly provenance: {
        readonly repository: string;
        readonly revision: string;
        readonly retrieval: string;
        readonly sourceFiles: ReadonlyArray<{ readonly path: string; readonly blobSha: string; readonly sha256: string }>;
        readonly packageLock: {
            readonly lockfileVersion: number;
            readonly packages: Readonly<Record<string, { readonly version: string; readonly integrity: string }>>;
        };
    };
    readonly comparisonSpace: {
        readonly conversion: string;
        readonly absoluteTolerance: number;
        readonly relativeTolerance: number;
    };
    readonly randomStream: {
        readonly algorithm: string;
        readonly scope: string;
        readonly draws: number;
        readonly semantics: Readonly<Record<string, string>>;
    };
    readonly assets: ReadonlyArray<{
        readonly model: string;
        readonly file: string;
        readonly sha256: string;
        readonly sourceNode: {
            readonly name: string;
            readonly mesh: number;
            readonly translation: readonly number[];
            readonly rotation: readonly number[];
            readonly scale: readonly number[];
        };
        readonly sourceHierarchy: ReadonlyArray<{
            readonly index: number;
            readonly localDeterminant: number;
        }>;
        readonly sourceOperation: string;
        readonly transformChain: {
            readonly importedHierarchyDeterminant: number;
            readonly sourceDetachedParentDeterminant: number;
            readonly sourceBakeDeterminant: number;
            readonly sourceBakedCarrierDeterminant: number;
            readonly liteSyntheticRootDeterminant: number;
            readonly liteDetachedParentDeterminant: number;
            readonly liteBakeDeterminant: number;
            readonly liteIndexWindingPermutation: number;
            readonly liteBakedCarrierDeterminant: number;
        };
        readonly sourceMaterial: {
            readonly family: "nme" | "pbr";
            readonly doubleSided: boolean;
            readonly expectedCullMode: GPUCullMode;
            readonly expectedFrontFaceAfterBake: GPUFrontFace;
        };
        readonly sourceGeometry: {
            readonly vertexCount: number;
            readonly indexCount: number;
            readonly minimum: readonly number[];
            readonly maximum: readonly number[];
            readonly selectedVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
            readonly selectedTriangles: ReadonlyArray<{
                readonly triangleOrdinal: number;
                readonly indices: readonly number[];
                readonly normals: readonly (readonly number[])[];
                readonly geometricNormal: readonly number[];
                readonly averagedNormal: readonly number[];
                readonly orientationDot: number;
                readonly tangentHandedness: readonly number[] | null;
            }>;
        };
        readonly comparisonGeometry: {
            readonly vertexCount: number;
            readonly indexCount: number;
            readonly minimum: readonly number[];
            readonly maximum: readonly number[];
            readonly selectedVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
            readonly selectedTriangles: ReadonlyArray<{
                readonly triangleOrdinal: number;
                readonly indices: readonly number[];
                readonly normals: readonly (readonly number[])[];
                readonly geometricNormal: readonly number[];
                readonly averagedNormal: readonly number[];
                readonly orientationDot: number;
                readonly tangentHandedness: readonly number[] | null;
            }>;
        };
    }>;
    readonly summary: {
        readonly placementCount: number;
        readonly batchCount: number;
        readonly instanceCount: number;
        readonly familyCounts: Readonly<Record<string, number>>;
        readonly modelCount: number;
    };
    readonly placements: ReadonlyArray<{
        readonly key: string;
        readonly family: string;
        readonly batches: ReadonlyArray<{
            readonly key: string;
            readonly model: string;
            readonly instances: ReadonlyArray<{
                readonly key: string;
                readonly source: {
                    readonly matrix: readonly number[];
                    readonly origin: readonly number[];
                    readonly basis: readonly (readonly number[])[];
                    readonly determinant: number;
                    readonly worldVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
                };
                readonly matrix: readonly number[];
                readonly origin: readonly number[];
                readonly basis: readonly (readonly number[])[];
                readonly determinant: number;
                readonly worldVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
            }>;
        }>;
    }>;
}

const fixturePath = resolve(process.cwd(), "tests", "lite", "fixtures", "playroom-source-transforms.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const cubeMarkers = JSON.parse(readFileSync(resolve(process.cwd(), "tests", "lite", "fixtures", "playroom-cube-stage-markers.json"), "utf8")) as {
    readonly sourceRevision: string;
    readonly cohorts: ReadonlyArray<{ readonly batchKey: string; readonly instanceIndices: readonly number[] }>;
    readonly checkpoints: ReadonlyArray<{ readonly name: string; readonly owner: string; readonly required: readonly string[] }>;
    readonly invariants: readonly string[];
};

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finite(values: readonly number[]): boolean {
    return values.every(Number.isFinite);
}

function reflectX(vector: readonly number[]): readonly number[] {
    return [vector[0] === 0 ? 0 : -vector[0]!, vector[1]!, vector[2]!];
}

function reflectMatrix(matrix: readonly number[]): number[] {
    const signs = [-1, 1, 1, 1];
    return matrix.map((value, index) => Math.fround(value * signs[index % 4]! * signs[Math.floor(index / 4)]!));
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => Object.is(value, expected[index]) || value === expected[index]);
}

describe("The Playroom pinned source transform fixture", () => {
    it("records immutable source and exact lockfile provenance", () => {
        expect(fixture.schemaVersion).toBe(2);
        expect(fixture.provenance.repository).toBe("BabylonJS/ThePlayroom");
        expect(fixture.provenance.revision).toBe("d22ce23ef308e28d1f8b6598b4c72ea944205925");
        expect(fixture.provenance.retrieval).toBe("authenticated read-only GitHub Contents API");
        expect(fixture.provenance.packageLock).toEqual({
            lockfileVersion: 2,
            packages: {
                "@babylonjs/core": {
                    version: "6.0.0",
                    integrity: "sha512-lQ0cDwhVrWn9MSf91UsvLbWMpIFW0P1YxNSghUG3yTOaf2ZpKEl9AmTrbN+lMfxkrGdgQQB+Bgd3khc2kkMkrA==",
                },
                "@babylonjs/havok": {
                    version: "1.0.0",
                    integrity: "sha512-vYDcsqPmCNSacNAhdU9SXU7zbI9NPbkxz/Xl7HqNmS3pB2UNhzpchTFWiOkmimdC/eq2ZfMDcSEVyiu10DkwWQ==",
                },
            },
        });
        expect(fixture.provenance.sourceFiles).toHaveLength(18);
        for (const source of fixture.provenance.sourceFiles) {
            expect(source.path).not.toContain("\\");
            expect(source.blobSha).toMatch(/^[0-9a-f]{40}$/u);
            expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
        }
    });

    it("covers every source family, placement, batch, and instance with finite geometry evidence", () => {
        expect(fixture.summary).toMatchObject({
            placementCount: 103,
            batchCount: 135,
            instanceCount: 1955,
            modelCount: 15,
            familyCounts: {
                domino: 12,
                stack: 1,
                tower: 1,
                cup: 9,
                bowlingBall: 1,
                bowlingPins: 1,
                ramp: 1,
                cubeStack: 41,
                cubes: 4,
                arch: 15,
                popper: 16,
                chess: 1,
            },
        });
        expect(new Set(fixture.placements.map((placement) => placement.key)).size).toBe(103);
        expect(new Set(fixture.assets.map((asset) => asset.model)).size).toBe(15);
        expect(fixture.comparisonSpace.conversion).toContain("F * sourceMatrix * F");
        expect(fixture.comparisonSpace.absoluteTolerance).toBe(0.00001);
        expect(fixture.comparisonSpace.relativeTolerance).toBe(0.000001);

        let batches = 0;
        let instances = 0;
        const instanceKeys = new Set<string>();
        for (const placement of fixture.placements) {
            batches += placement.batches.length;
            for (const batch of placement.batches) {
                for (const instance of batch.instances) {
                    instances++;
                    expect(instanceKeys.has(instance.key), instance.key).toBe(false);
                    instanceKeys.add(instance.key);
                    expect(instance.matrix).toHaveLength(16);
                    expect(instance.source.matrix).toHaveLength(16);
                    expect(instance.origin).toHaveLength(3);
                    expect(instance.source.origin).toHaveLength(3);
                    expect(instance.basis).toHaveLength(3);
                    expect(instance.source.basis).toHaveLength(3);
                    expect(instance.worldVertices.length).toBeGreaterThanOrEqual(3);
                    expect(
                        finite([
                            ...instance.matrix,
                            ...instance.origin,
                            ...instance.basis.flat(),
                            instance.determinant,
                            ...instance.source.matrix,
                            ...instance.source.origin,
                            ...instance.source.basis.flat(),
                            instance.source.determinant,
                        ])
                    ).toBe(true);
                    expect(instance.worldVertices.every((vertex) => finite(vertex.position))).toBe(true);
                    expect(instance.source.worldVertices.every((vertex) => finite(vertex.position))).toBe(true);
                }
            }
        }
        expect(batches).toBe(fixture.summary.batchCount);
        expect(instances).toBe(fixture.summary.instanceCount);
    });

    it("keeps native source evidence and the explicit handedness conversion consistent", () => {
        for (const asset of fixture.assets) {
            for (let index = 0; index < asset.sourceGeometry.selectedVertices.length; index++) {
                const source = asset.sourceGeometry.selectedVertices[index]!;
                const comparison = asset.comparisonGeometry.selectedVertices[index]!;
                expect(comparison.index).toBe(source.index);
                expect(comparison.position).toEqual([source.position[0] === 0 ? 0 : -source.position[0]!, source.position[1]!, source.position[2]!]);
            }
        }
        for (const placement of fixture.placements) {
            for (const batch of placement.batches) {
                for (const instance of batch.instances) {
                    if (!sameNumbers(instance.matrix, reflectMatrix(instance.source.matrix))) {
                        throw new Error(`${instance.key} does not implement F * sourceMatrix * F.`);
                    }
                    if (!sameNumbers(instance.origin, instance.matrix.slice(12, 15)) || !sameNumbers(instance.source.origin, instance.source.matrix.slice(12, 15))) {
                        throw new Error(`${instance.key} has inconsistent origin evidence.`);
                    }
                    const basis = [instance.matrix.slice(0, 3), instance.matrix.slice(4, 7), instance.matrix.slice(8, 11)];
                    const sourceBasis = [instance.source.matrix.slice(0, 3), instance.source.matrix.slice(4, 7), instance.source.matrix.slice(8, 11)];
                    if (
                        basis.some((value, index) => !sameNumbers(value, instance.basis[index]!)) ||
                        sourceBasis.some((value, index) => !sameNumbers(value, instance.source.basis[index]!))
                    ) {
                        throw new Error(`${instance.key} has inconsistent basis evidence.`);
                    }
                }
            }
        }
    });

    it("pins source assets and records imported TRS plus explicit source operations", () => {
        for (const asset of fixture.assets) {
            const path = resolve(process.cwd(), "lab", "public", "playroom", "gltf", asset.file);
            expect(sha256(path), asset.file).toBe(asset.sha256);
            expect(asset.sourceNode.mesh).toBeTypeOf("number");
            expect(asset.sourceNode.translation).toHaveLength(3);
            expect(asset.sourceNode.rotation).toHaveLength(4);
            expect(asset.sourceNode.scale).toHaveLength(3);
            expect(asset.sourceOperation.length).toBeGreaterThan(20);
            expect(asset.sourceGeometry.vertexCount).toBeGreaterThan(0);
            expect(finite([...asset.sourceGeometry.minimum, ...asset.sourceGeometry.maximum])).toBe(true);
            expect(asset.sourceGeometry.selectedVertices.length).toBeGreaterThanOrEqual(3);
            expect(asset.comparisonGeometry.vertexCount).toBeGreaterThan(0);
            expect(finite([...asset.comparisonGeometry.minimum, ...asset.comparisonGeometry.maximum])).toBe(true);
            expect(asset.comparisonGeometry.selectedVertices.length).toBeGreaterThanOrEqual(3);
        }
        const byModel = new Map(fixture.assets.map((asset) => [asset.model, asset]));
        expect(byModel.get("arch")!.sourceNode.scale).toEqual([0.25, 0.25, 0.25]);
        expect(byModel.get("arch")!.sourceOperation).toContain("replace scale");
        expect(byModel.get("archTop")!.sourceNode.scale).toEqual([0.6148998141288757, 0.6148998141288757, 0.25]);
        expect(byModel.get("archTop")!.sourceOperation).toContain("[0.5,0.5,0.2]");
        expect(byModel.get("chessboard")!.sourceNode.scale).toEqual([0.75, 0.75, 0.75]);
        expect(byModel.get("chessboard")!.sourceOperation).toContain("[0.6,0.6,0.6]");
    });

    it("pins the signed hierarchy, bake, winding, normal, tangent, carrier, and pipeline chain", () => {
        for (const asset of fixture.assets) {
            expect(asset.sourceHierarchy.length).toBeGreaterThan(0);
            expect(asset.transformChain.importedHierarchyDeterminant).toBeGreaterThan(0);
            expect(asset.transformChain.sourceDetachedParentDeterminant).toBe(1);
            expect(asset.transformChain.sourceBakeDeterminant).toBeGreaterThan(0);
            expect(asset.transformChain.sourceBakedCarrierDeterminant).toBe(1);
            expect(asset.transformChain.liteSyntheticRootDeterminant).toBe(-1);
            expect(asset.transformChain.liteDetachedParentDeterminant).toBe(1);
            expect(asset.transformChain.liteBakeDeterminant).toBeLessThan(0);
            expect(asset.transformChain.liteIndexWindingPermutation).toBe(-1);
            expect(asset.transformChain.liteBakedCarrierDeterminant).toBe(1);
            expect(asset.sourceMaterial.expectedFrontFaceAfterBake).toBe("ccw");
            expect(asset.sourceMaterial.expectedCullMode).toBe(asset.sourceMaterial.doubleSided ? "none" : "back");
            expect(asset.sourceGeometry.indexCount).toBe(asset.comparisonGeometry.indexCount);
            for (let index = 0; index < asset.sourceGeometry.selectedTriangles.length; index++) {
                const source = asset.sourceGeometry.selectedTriangles[index]!;
                const comparison = asset.comparisonGeometry.selectedTriangles[index]!;
                expect(comparison.triangleOrdinal).toBe(source.triangleOrdinal);
                expect(comparison.indices).toEqual([source.indices[0], source.indices[2], source.indices[1]]);
                expect(source.orientationDot).toBeGreaterThan(0);
                expect(comparison.orientationDot).toBeGreaterThan(0);
                expect(comparison.geometricNormal).toEqual(reflectX(source.geometricNormal));
                expect(comparison.averagedNormal).toEqual(reflectX(source.averagedNormal));
                const reflectedVertexOrder = [0, 2, 1];
                for (let vertex = 0; vertex < 3; vertex++) {
                    expect(comparison.normals[vertex]).toEqual(reflectX(source.normals[reflectedVertexOrder[vertex]!]!));
                }
                if (source.tangentHandedness) {
                    expect(comparison.tangentHandedness).toEqual(reflectedVertexOrder.map((vertex) => -source.tangentHandedness![vertex]!));
                } else {
                    expect(comparison.tangentHandedness).toBeNull();
                }
            }
        }
        for (const placement of fixture.placements) {
            for (const batch of placement.batches) {
                for (const instance of batch.instances) {
                    expect(instance.source.determinant).toBeGreaterThan(0);
                    expect(instance.determinant).toBeGreaterThan(0);
                }
            }
        }
    });

    it("pins stable cube identities and every later physics checkpoint boundary", () => {
        expect(cubeMarkers.sourceRevision).toBe(fixture.provenance.revision);
        const batches = new Map(fixture.placements.flatMap((placement) => placement.batches).map((batch) => [batch.key, batch]));
        for (const cohort of cubeMarkers.cohorts) {
            const batch = batches.get(cohort.batchKey);
            expect(batch?.model, cohort.batchKey).toBe("cube");
            for (const index of cohort.instanceIndices) {
                expect(batch?.instances[index], `${cohort.batchKey}/${index}`).toBeDefined();
            }
        }
        expect(cubeMarkers.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
            "geometry-only-output",
            "gpu-consumed-matrix-and-vertices",
            "immediately-before-native-body-creation",
            "after-native-creation-before-step",
            "first-zero-gravity-zero-motion-sync",
            "first-gravity-contact",
        ]);
        expect(cubeMarkers.checkpoints.filter((checkpoint) => checkpoint.owner === "later-physics-task")).toHaveLength(4);
        expect(cubeMarkers.invariants.join(" ")).toContain("carrier and instance transforms exactly once");
        expect(cubeMarkers.invariants.join(" ")).toContain("Strip render scale exactly once");
        expect(cubeMarkers.invariants.join(" ")).toContain("shape-local center");
    });

    it("separates deterministic transform draws from cosmetic random draws", () => {
        expect(fixture.randomStream.algorithm).toContain("LCG32");
        expect(fixture.randomStream.scope).toContain("source world construction order");
        expect(fixture.randomStream.draws).toBe(1196);
        expect(fixture.randomStream.semantics.stack).toContain("rotation, x offset, z offset");
        expect(fixture.randomStream.semantics.cubeStack).toContain("cosmetic color");
        expect(fixture.randomStream.semantics.cubes).toContain("transform rotation");
        expect(fixture.randomStream.semantics.arch).toContain("cosmetic color");
    });
});
