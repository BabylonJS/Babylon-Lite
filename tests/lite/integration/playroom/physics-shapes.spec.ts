import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

interface SourceBox {
    center: number[];
    extents: number[];
    effectiveInstanceScale: number[];
}

interface ShapeCall {
    id: string;
    type: string;
    center?: number[];
    extents?: number[];
    children?: string[];
    childTransforms?: number[][][];
}

interface Snapshot {
    sourceRevision: string;
    records: Array<{
        batchKey: string;
        model: string;
        nativeIds: string[];
        nativeShapeIds: string[];
        shape: ShapeCall;
    }>;
    carrierReflectionProbe: {
        nativeShape: ShapeCall;
    };
}

const source = JSON.parse(readFileSync(resolve(process.cwd(), "tests/lite/fixtures/playroom-source-physics.json"), "utf8")) as {
    provenance: { revision: string };
    boxes: Record<string, SourceBox>;
};
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

function expectNumbers(actual: readonly number[] | undefined, expected: readonly number[]): void {
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) {
        expect(actual![index]!, `number ${index}`).toBeCloseTo(expected[index]!, 12);
    }
}

test.describe.configure({ mode: "serial" });
let data: Snapshot;

test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    data = await snapshot(page);
    await page.close();
});

test("binds pinned source boxes directly to every unit-scale native Playroom instance", () => {
    expect(data.sourceRevision).toBe(source.provenance.revision);
    for (const [model, expected] of Object.entries(source.boxes)) {
        const records = data.records.filter((record) => record.model === model);
        expect(records.length, model).toBeGreaterThan(0);
        for (const record of records) {
            expect(record.shape.type, record.batchKey).toBe("box");
            expectNumbers(record.shape.center, expected.center);
            expectNumbers(record.shape.extents, expected.extents);
            expect(expected.effectiveInstanceScale, record.batchKey).toEqual([1, 1, 1]);
            expect(new Set(record.nativeShapeIds), record.batchKey).toEqual(new Set([record.shape.id]));
            expect(record.nativeShapeIds, record.batchKey).toHaveLength(record.nativeIds.length);
        }
    }
});

test("binds a signed scaled wrapper for mirrored nonuniform effective geometry", () => {
    const shape = data.carrierReflectionProbe.nativeShape;
    expect(shape.type).toBe("container");
    expect(shape.children).toHaveLength(1);
    expect(shape.childTransforms).toHaveLength(1);
    expectNumbers(shape.childTransforms![0]![0], [0, 0, 0]);
    expectNumbers(shape.childTransforms![0]![1], [0, 0, 0, 1]);
    expectNumbers(shape.childTransforms![0]![2], [2, -3, 4]);
});
