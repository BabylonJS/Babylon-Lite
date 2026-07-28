import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BRDF_LUT_DATA_URL } from "../src/scene/brdf-lut-data";

const PREFIX = "data:image/png;base64,";

describe("embedded BRDF LUT", () => {
    it("stays byte-identical to the Babylon Lite BRDF asset", () => {
        const asset = readFileSync(fileURLToPath(new URL("../../babylon-lite/assets/brdf-lut.png", import.meta.url)));

        expect(BRDF_LUT_DATA_URL.startsWith(PREFIX)).toBe(true);
        expect(Buffer.from(BRDF_LUT_DATA_URL.slice(PREFIX.length), "base64").equals(asset)).toBe(true);
    });
});
