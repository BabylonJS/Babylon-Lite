import { cubeStageMarkers, expect, sourceFixture, test } from "./fixtures.js";
import type { SourceGeometry, SourceInstance } from "./fixtures.js";
import type { ObservedBuffer, ObservedBundleDraw, RenderBundleObservation } from "./webgpu-render-bundle-observer.js";

function expectNumber(actual: number, expected: number, label: string): void {
    const tolerance = sourceFixture.comparisonSpace.absoluteTolerance + Math.abs(expected) * sourceFixture.comparisonSpace.relativeTolerance;
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${label}: expected ${expected}, received ${actual}, tolerance ${tolerance}`);
    }
}

function expectVector(actual: readonly number[], expected: readonly number[], label: string): void {
    if (actual.length !== expected.length) {
        throw new Error(`${label}: expected ${expected.length} values, received ${actual.length}`);
    }
    for (let index = 0; index < expected.length; index++) {
        expectNumber(actual[index]!, expected[index]!, `${label}[${index}]`);
    }
}

function determinant(matrix: readonly number[]): number {
    const [a, b, c, , d, e, f, , g, h, i] = matrix;
    return a! * (e! * i! - f! * h!) - d! * (b! * i! - c! * h!) + g! * (b! * f! - c! * e!);
}

function transformPoint(matrix: readonly number[], point: readonly number[]): number[] {
    return [
        matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
        matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
        matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!,
    ];
}

function normalizedMatrixPayload(observation: RenderBundleObservation, draw: ObservedBundleDraw): number[] {
    const buffers = new Map(observation.buffers.map((buffer) => [buffer.id, buffer]));
    const pipeline = observation.pipelines.find((entry) => entry.id === draw.pipelineId);
    expect(pipeline, "matrix buffer pipeline").toBeDefined();
    const matrixSlots = new Set(pipeline!.vertexBuffers.filter((layout) => layout.stepMode === "instance" && layout.arrayStride === 64).map((layout) => layout.slot));
    const matrixBindings = draw.vertexBuffers
        .filter((binding) => matrixSlots.has(binding.slot))
        .map((binding) => buffers.get(binding.bufferId))
        .filter((buffer): buffer is ObservedBuffer => buffer?.label === "thin-instance-matrices" && buffer.size === draw.instanceCount * 64);
    const matrixBufferCandidates = [...new Map(matrixBindings.map((buffer) => [buffer.id, buffer])).values()];
    expect(matrixBufferCandidates, "pipeline-declared matrix buffer binding").toHaveLength(1);
    const bytes = Buffer.from(matrixBufferCandidates[0]!.dataBase64, "base64");
    return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT), (value) => (value === 0 ? 0 : value));
}

function floatBuffer(buffer: ObservedBuffer): Float32Array {
    const bytes = Buffer.from(buffer.dataBase64, "base64");
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function compareInstance(actual: readonly number[], expected: SourceInstance, geometry: SourceGeometry): void {
    expectVector(actual, expected.matrix, `${expected.key} matrix`);
    expectVector(actual.slice(12, 15), expected.origin, `${expected.key} origin`);
    expectVector(actual.slice(0, 3), expected.basis[0]!, `${expected.key} X basis`);
    expectVector(actual.slice(4, 7), expected.basis[1]!, `${expected.key} Y basis`);
    expectVector(actual.slice(8, 11), expected.basis[2]!, `${expected.key} Z basis`);
    expectNumber(determinant(actual), expected.determinant, `${expected.key} determinant`);
    for (let index = 0; index < geometry.selectedVertices.length; index++) {
        const vertex = geometry.selectedVertices[index]!;
        if (vertex.index !== expected.worldVertices[index]!.index) {
            throw new Error(`${expected.key} selected vertex identity: expected ${expected.worldVertices[index]!.index}, received ${vertex.index}`);
        }
        expectVector(transformPoint(actual, vertex.position), expected.worldVertices[index]!.position, `${expected.key} vertex ${vertex.index}`);
    }
}

test("renders the complete source placement inventory without physics", async ({ litePlacement }) => {
    expect(litePlacement.physics).toBe("absent");
    expect(litePlacement.placements).toHaveLength(sourceFixture.summary.placementCount);
    expect(litePlacement.renderedBatchCount).toBe(sourceFixture.summary.batchCount);
    expect(litePlacement.renderedInstanceCount).toBe(sourceFixture.summary.instanceCount);
    expect(litePlacement.placements.map((placement) => placement.key)).toEqual(sourceFixture.placements.map((placement) => placement.key));
});

test("observes every opaque instance draw in the main and shadow render bundles", async ({ litePlacementBundles }) => {
    const { observation, placement } = litePlacementBundles;
    expect(observation.createRenderBundleEncoderCount).toBeGreaterThan(0);
    expect(observation.finishCount).toBeGreaterThan(0);
    expect(observation.executeBundlesCallCount).toBeGreaterThan(0);

    const executedBundleIds = new Set(observation.executeBundlesMemberships.flatMap((membership) => membership.bundleIds));
    expect(observation.executedBundles.every((bundle) => executedBundleIds.has(bundle.bundleId))).toBe(true);
    const expectedBatches = placement.placements.flatMap((entry) => entry.batches);
    const expectedAssets = new Map(sourceFixture.assets.map((asset) => [asset.model, asset]));
    const pipelines = new Map(observation.pipelines.map((pipeline) => [pipeline.id, pipeline]));
    const passes = [
        { name: "shadow", bundles: observation.executedBundles.filter((bundle) => bundle.descriptor.colorFormats.length === 0), fragmentTargetCount: 0 },
        { name: "main", bundles: observation.executedBundles.filter((bundle) => bundle.descriptor.colorFormats.length > 0), fragmentTargetCount: 1 },
    ] as const;
    for (const pass of passes) {
        expect(pass.bundles, `${pass.name} bundle`).toHaveLength(1);
        const draws = pass.bundles.flatMap((bundle) => bundle.draws);
        expect(draws, `${pass.name} draws`).toHaveLength(sourceFixture.summary.batchCount);
        expect(
            draws.reduce((total, draw) => total + draw.instanceCount, 0),
            `${pass.name} instances`
        ).toBe(sourceFixture.summary.instanceCount);
        const expectedKeysByPayload = new Map<string, string[]>();
        for (const batch of expectedBatches) {
            const signature = JSON.stringify(batch.matrices.flat().map((value) => (value === 0 ? 0 : value)));
            const keys = expectedKeysByPayload.get(signature) ?? [];
            keys.push(batch.key);
            expectedKeysByPayload.set(signature, keys);
        }
        const matchedKeys = new Set<string>();
        for (let drawIndex = 0; drawIndex < draws.length; drawIndex++) {
            const draw = draws[drawIndex]!;
            const matrices = normalizedMatrixPayload(observation, draw);
            const matchingKeys = expectedKeysByPayload.get(JSON.stringify(matrices));
            expect(matchingKeys?.length, `${pass.name} draw ${drawIndex} matrix payload`).toBeGreaterThan(0);
            const batchKey = matchingKeys!.pop()!;
            matchedKeys.add(batchKey);
            const expectedBatch = expectedBatches.find((batch) => batch.key === batchKey)!;
            const expectedAsset = expectedAssets.get(expectedBatch.model)!;
            const pipeline = pipelines.get(draw.pipelineId!);
            expect(pipeline, `${pass.name} ${batchKey} pipeline`).toBeDefined();
            expect(pipeline!.primitive.frontFace, `${pass.name} ${batchKey} frontFace`).toBe(expectedAsset.sourceMaterial.expectedFrontFaceAfterBake);
            expect(pipeline!.primitive.cullMode, `${pass.name} ${batchKey} cullMode`).toBe(expectedAsset.sourceMaterial.expectedCullMode);
            expect(pipeline!.fragmentTargetCount, `${pass.name} ${batchKey} fragment targets`).toBe(pass.fragmentTargetCount);
            if (expectedAsset.sourceMaterial.family === "nme") {
                expect(pipeline!.label, `${pass.name} ${batchKey} NME pipeline`).toBe(pass.name === "shadow" ? "node-material-depth" : "node-material");
            }
            expect(draw.indexBuffer, `${pass.name} ${batchKey} index buffer`).not.toBeNull();
            expect(draw.indexCount, `${pass.name} ${batchKey} index count`).toBeGreaterThan(0);
        }
        expect(matchedKeys.size, `${pass.name} mapped batches`).toBe(expectedBatches.length);
    }
});

test("retains reflected tangent handedness in baked GPU geometry", async ({ litePlacementBundles }) => {
    const { observation } = litePlacementBundles;
    for (const asset of sourceFixture.assets.filter((entry) => entry.comparisonGeometry.selectedTriangles.some((triangle) => triangle.tangentHandedness))) {
        const candidates = observation.createdBuffers.filter((buffer) => {
            if (buffer.size !== asset.comparisonGeometry.vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT) {
                return false;
            }
            const values = floatBuffer(buffer);
            return asset.comparisonGeometry.selectedTriangles.every(
                (triangle) => triangle.tangentHandedness?.every((expected, index) => values[triangle.indices[index]! * 4 + 3] === expected) ?? false
            );
        });
        expect(candidates, `${asset.model} transformed tangent GPU buffer`).toHaveLength(1);
    }
});

test("keeps stable cube stage markers identical between geometry output and GPU bundles", async ({ litePlacementBundles }) => {
    const { observation, placement } = litePlacementBundles;
    const actualBatches = new Map(placement.placements.flatMap((entry) => entry.batches).map((batch) => [batch.key, batch]));
    const mainDraws = observation.executedBundles.filter((bundle) => bundle.descriptor.colorFormats.length > 0).flatMap((bundle) => bundle.draws);
    const gpuPayloads = new Map(mainDraws.map((draw) => [JSON.stringify(normalizedMatrixPayload(observation, draw)), normalizedMatrixPayload(observation, draw)]));
    for (const cohort of cubeStageMarkers.cohorts) {
        const actual = actualBatches.get(cohort.batchKey)!;
        const signature = JSON.stringify(actual.matrices.flat().map((value) => (value === 0 ? 0 : value)));
        const gpu = gpuPayloads.get(signature);
        expect(gpu, cohort.batchKey).toBeDefined();
        for (const instanceIndex of cohort.instanceIndices) {
            expectVector(gpu!.slice(instanceIndex * 16, instanceIndex * 16 + 16), actual.matrices[instanceIndex]!, `${cohort.batchKey}/${instanceIndex} GPU matrix`);
        }
    }
});

test("matches pinned source at stable cube stage markers before physics", async ({ litePlacement }) => {
    const actualModels = new Map(litePlacement.models.map((model) => [model.model, model]));
    const actualBatches = new Map(litePlacement.placements.flatMap((entry) => entry.batches).map((batch) => [batch.key, batch]));
    const expectedBatches = new Map(sourceFixture.placements.flatMap((entry) => entry.batches).map((batch) => [batch.key, batch]));
    for (const cohort of cubeStageMarkers.cohorts) {
        const actual = actualBatches.get(cohort.batchKey)!;
        const expected = expectedBatches.get(cohort.batchKey)!;
        const geometry = actualModels.get(expected.model)!;
        for (const instanceIndex of cohort.instanceIndices) {
            compareInstance(actual.matrices[instanceIndex]!, expected.instances[instanceIndex]!, geometry);
        }
    }
});

test("matches pinned source geometry and every authored instance transform", async ({ litePlacement }) => {
    const actualModels = new Map(litePlacement.models.map((model) => [model.model, model]));
    for (const expectedAsset of sourceFixture.assets) {
        const actual = actualModels.get(expectedAsset.model);
        expect(actual, `${expectedAsset.model} geometry`).toBeDefined();
        expect(actual!.vertexCount, `${expectedAsset.model} vertex count`).toBe(expectedAsset.comparisonGeometry.vertexCount);
        expect(actual!.indexCount, `${expectedAsset.model} index count`).toBe(expectedAsset.comparisonGeometry.indexCount);
        expectVector(actual!.minimum, expectedAsset.comparisonGeometry.minimum, `${expectedAsset.model} minimum`);
        expectVector(actual!.maximum, expectedAsset.comparisonGeometry.maximum, `${expectedAsset.model} maximum`);
        for (let index = 0; index < expectedAsset.comparisonGeometry.selectedVertices.length; index++) {
            const expected = expectedAsset.comparisonGeometry.selectedVertices[index]!;
            const vertex = actual!.selectedVertices[index]!;
            expect(vertex.index, `${expectedAsset.model} selected vertex identity`).toBe(expected.index);
            expectVector(vertex.position, expected.position, `${expectedAsset.model} vertex ${expected.index}`);
        }
        for (let index = 0; index < expectedAsset.comparisonGeometry.selectedTriangles.length; index++) {
            const expected = expectedAsset.comparisonGeometry.selectedTriangles[index]!;
            const triangle = actual!.selectedTriangles[index]!;
            expect(triangle.triangleOrdinal, `${expectedAsset.model} triangle ordinal`).toBe(expected.triangleOrdinal);
            const liteVertexOrder = [0, 2, 1] as const;
            expect(triangle.indices, `${expectedAsset.model} triangle ${expected.triangleOrdinal} indices`).toEqual(liteVertexOrder.map((vertex) => expected.indices[vertex]));
            for (let vertex = 0; vertex < 3; vertex++) {
                const expectedVertex = liteVertexOrder[vertex]!;
                expectVector(triangle.positions[vertex]!, expected.positions[expectedVertex]!, `${expectedAsset.model} triangle ${expected.triangleOrdinal} position ${vertex}`);
                expectVector(triangle.normals[vertex]!, expected.normals[expectedVertex]!, `${expectedAsset.model} triangle ${expected.triangleOrdinal} normal ${vertex}`);
            }
            expectVector(
                triangle.geometricNormal,
                expected.geometricNormal.map((value) => -value),
                `${expectedAsset.model} triangle ${expected.triangleOrdinal} geometric normal`
            );
            expectVector(triangle.averagedNormal, expected.averagedNormal, `${expectedAsset.model} triangle ${expected.triangleOrdinal} averaged normal`);
            expectNumber(triangle.orientationDot, -expected.orientationDot, `${expectedAsset.model} triangle ${expected.triangleOrdinal} orientation`);
            expect(triangle.orientationDot, `${expectedAsset.model} triangle ${expected.triangleOrdinal} uses Lite's visible-face winding`).toBeLessThan(0);
            if (expected.tangentHandedness === null) {
                expect(triangle.tangentHandedness, `${expectedAsset.model} triangle ${expected.triangleOrdinal} tangent handedness`).toBeNull();
            }
        }
    }

    const actualPlacements = new Map(litePlacement.placements.map((placement) => [placement.key, placement]));
    for (const expectedPlacement of sourceFixture.placements) {
        const actualPlacement = actualPlacements.get(expectedPlacement.key);
        expect(actualPlacement, expectedPlacement.key).toBeDefined();
        const actualBatches = new Map(actualPlacement!.batches.map((batch) => [batch.key, batch]));
        for (const expectedBatch of expectedPlacement.batches) {
            const actualBatch = actualBatches.get(expectedBatch.key);
            expect(actualBatch, expectedBatch.key).toBeDefined();
            expect(actualBatch!.matrices, `${expectedBatch.key} instance count`).toHaveLength(expectedBatch.instances.length);
            const geometry = actualModels.get(expectedBatch.model)!;
            for (let index = 0; index < expectedBatch.instances.length; index++) {
                compareInstance(actualBatch!.matrices[index]!, expectedBatch.instances[index]!, geometry);
            }
        }
    }
});
