import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compareImages } from "../../shared/compare-core";

const tempDir = mkdtempSync(join(tmpdir(), "lite-compare-core-"));

function writePixel(name: string, red: number): string {
    const filePath = join(tempDir, name);
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([red, 20, 30, 255]);
    writeFileSync(filePath, PNG.sync.write(png));
    return filePath;
}

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("compareImages channel tolerance", () => {
    it("ignores only deltas at or below the requested quantization floor", () => {
        const reference = writePixel("reference.png", 10);
        const oneLsb = writePixel("one-lsb.png", 11);
        const twoLsb = writePixel("two-lsb.png", 12);

        expect(compareImages(oneLsb, reference).mad).toBeCloseTo(1 / 3);
        expect(compareImages(oneLsb, reference, 1).mad).toBe(0);
        expect(compareImages(twoLsb, reference, 1).mad).toBeCloseTo(2 / 3);
    });
});
