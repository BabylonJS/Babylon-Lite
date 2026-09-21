import { expect, test } from "@playwright/test";

interface MatrixStage {
    matrix: number[];
    determinant: number;
    worldVertices: number[][];
    nativeId: string;
}

interface Snapshot {
    sourceRevision: string;
    counts: { logicalRecords: number; propBatchRecords: number; activeRenderInstances: number; nativeBodies: number };
    records: Array<{
        batchKey: string;
        model: string;
        renderInstanceCount: number;
        nativeInstanceCount: number;
        nativeIds: string[];
        shape: {
            type: string;
            center?: number[];
            extents?: number[];
            pointA?: number[];
            pointB?: number[];
            radius?: number;
            vertexCount?: number;
            triangleCount?: number;
            children?: string[];
        };
    }>;
    cubeStages: Array<{
        batchKey: string;
        instanceIndex: number;
        beforeNativeCreation: MatrixStage;
        afterNativeCreation: MatrixStage;
        firstZeroGravitySync: MatrixStage;
        firstGravityContact?: MatrixStage;
    }>;
    indexedControls: Array<{
        batchKey: string;
        firstIndex: number;
        lastIndex: number;
        firstVelocity: number[];
        middleVelocity: number[];
        lastVelocity: number[];
        raycastIndex: number;
    }>;
    contacts: Array<{ batchKey: string; instanceIndex: number }>;
    carrierReflectionProbe: { nativeAfterCreation: MatrixStage; effectiveAfterWriteBack: MatrixStage };
}

const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);

async function snapshot(page: import("@playwright/test").Page): Promise<Snapshot> {
    await page.goto(`http://127.0.0.1:${labTestPort}/lite/playroom-physics-harness.html`);
    await page.waitForFunction(() => {
        const canvas = document.getElementById("renderCanvas");
        return canvas?.dataset.ready === "true" || Boolean(canvas?.dataset.error);
    });
    const error = await page.locator("#renderCanvas").getAttribute("data-error");
    expect(error).toBeNull();
    return JSON.parse((await page.locator("#playroom-physics-snapshot").textContent())!) as Snapshot;
}

function expectNumbers(actual: readonly number[], expected: readonly number[], digits = 5): void {
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) {
        expect(actual[index]!, `number ${index}`).toBeCloseTo(expected[index]!, digits);
    }
}

test.describe.configure({ mode: "serial" });
let data: Snapshot;

test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    data = await snapshot(page);
    await page.close();
});

test("creates source-shaped native bodies one-for-one with rendered instances", () => {
    expect(data.sourceRevision).toBe("d22ce23ef308e28d1f8b6598b4c72ea944205925");
    expect(data.counts).toEqual({ logicalRecords: 140, propBatchRecords: 135, activeRenderInstances: 1955, nativeBodies: 1960 });
    expect(data.records).toHaveLength(135);
    expect(new Set(data.records.flatMap((record) => record.nativeIds)).size).toBe(1955);
    for (const record of data.records) {
        expect(record.nativeInstanceCount, record.batchKey).toBe(record.renderInstanceCount);
        expect(record.nativeIds, record.batchKey).toHaveLength(record.renderInstanceCount);
        expect(new Set(record.nativeIds).size, record.batchKey).toBe(record.renderInstanceCount);
    }

    const byModel = new Map(data.records.map((record) => [record.model, record.shape]));
    expect(byModel.get("domino")).toMatchObject({ type: "box", center: [0, 0.16, 0], extents: [0.176, 0.32, 0.042] });
    expect(byModel.get("transformedTowerGameBlock")).toMatchObject({ type: "box", center: [0, 0, 0], extents: [0.5, 1.5, 0.3] });
    expect(byModel.get("bowlingBall")).toMatchObject({ type: "sphere", center: [0, 0, 0], radius: 0.5 });
    expect(byModel.get("archCylinder")).toMatchObject({ type: "cylinder", pointA: [0, 0, 0], pointB: [0, 0.6, 0], radius: 0.12 });
    expect(byModel.get("cup")).toMatchObject({ type: "convex" });
    expect(byModel.get("bowlingPin")).toMatchObject({ type: "convex" });
    expect(byModel.get("archTop")).toMatchObject({ type: "convex" });
    expect(byModel.get("chessWhite")).toMatchObject({ type: "convex" });
    expect(byModel.get("ramp")).toMatchObject({ type: "mesh" });
    expect(byModel.get("arch")).toMatchObject({ type: "container" });
    expect(byModel.get("arch")!.children).toHaveLength(3);
});

test("keeps stable cube world vertices through native creation and first synchronization", () => {
    expect(data.cubeStages).toHaveLength(6);
    for (const marker of data.cubeStages) {
        expectNumbers(marker.afterNativeCreation.matrix, marker.beforeNativeCreation.matrix);
        expectNumbers(marker.firstZeroGravitySync.matrix, marker.beforeNativeCreation.matrix);
        expect(marker.afterNativeCreation.determinant).toBeGreaterThan(0);
        expect(marker.firstZeroGravitySync.determinant).toBeGreaterThan(0);
        expect(marker.afterNativeCreation.nativeId).toBe(marker.beforeNativeCreation.nativeId);
        expect(marker.firstZeroGravitySync.nativeId).toBe(marker.beforeNativeCreation.nativeId);
        for (let index = 0; index < marker.beforeNativeCreation.worldVertices.length; index++) {
            expectNumbers(marker.afterNativeCreation.worldVertices[index]!, marker.beforeNativeCreation.worldVertices[index]!);
            expectNumbers(marker.firstZeroGravitySync.worldVertices[index]!, marker.beforeNativeCreation.worldVertices[index]!);
        }
    }
});

test("preserves effective carrier TRS and reflected winding across real Havok write-back", () => {
    const probe = data.carrierReflectionProbe;
    expectNumbers(probe.nativeAfterCreation.matrix.slice(12, 15), [4, 25, 37]);
    expectNumbers(probe.effectiveAfterWriteBack.matrix, [0, -2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 4, 25, 37, 1]);
    expect(probe.effectiveAfterWriteBack.determinant).toBeCloseTo(-24, 5);
    expect(probe.effectiveAfterWriteBack.nativeId).toBe(probe.nativeAfterCreation.nativeId);
});

test("targets first and last native cubes without broadcasting and preserves query/contact indices", () => {
    for (const control of data.indexedControls) {
        expect(control.firstIndex).toBe(0);
        expect(control.firstVelocity[0]).toBeGreaterThan(0);
        expect(control.lastVelocity[0]).toBeLessThan(0);
        expectNumbers(control.middleVelocity, [0, 0, 0]);
        expect(control.raycastIndex).toBe(control.lastIndex);
    }
    expect(data.contacts.some((contact) => contact.batchKey === "cubeStack/000/cube" && contact.instanceIndex === 0)).toBe(true);
    expect(data.contacts.some((contact) => contact.batchKey === "cubes/003/cube" && contact.instanceIndex === 0)).toBe(true);
    expect(data.cubeStages.filter((marker) => marker.firstGravityContact)).not.toHaveLength(0);
});
