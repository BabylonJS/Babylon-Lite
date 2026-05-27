import { expect, test } from "@playwright/test";

import { shouldSkipParity } from "./compare-utils";

test.describe("scene-config parity skip options", () => {
    test("skipParityOnCI skips only when CI is set", () => {
        expect(shouldSkipParity({ skipParityOnCI: true }, {})).toBe(false);
        expect(shouldSkipParity({ skipParityOnCI: true }, { CI: "true" })).toBe(true);
    });

    test("skipParity remains an unconditional parity skip", () => {
        expect(shouldSkipParity({ skipParity: true }, {})).toBe(true);
        expect(shouldSkipParity({ skipParity: true, skipParityOnCI: true }, {})).toBe(true);
    });
});
