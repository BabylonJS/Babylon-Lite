/**
 * The two `#coordinate-system` variants (see packages/babylon-lite/src/engine/coordinate-system.ts):
 * the default build is left-handed and `babylon-lite-rh` is right-handed, both as constants the
 * bundler folds. The package `imports` map must route each bundler condition to its variant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as leftHanded from "../../../packages/babylon-lite/src/engine/coordinate-system";
import * as rightHanded from "../../../packages/babylon-lite/src/engine/coordinate-system-rh";

describe("coordinate-system variants", () => {
    it("default build is left-handed", () => {
        expect(leftHanded._rightHanded).toBeNull();
    });

    it("babylon-lite-rh build is right-handed", () => {
        expect(rightHanded._rightHanded).toBe(true);
    });

    it("package imports map routes each condition to its variant", () => {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/babylon-lite/package.json"), "utf8")) as {
            imports: Record<string, Record<string, string>>;
        };
        expect(pkg.imports["#coordinate-system"]).toEqual({
            "babylon-lite-rh": "./src/engine/coordinate-system-rh.ts",
            default: "./src/engine/coordinate-system.ts",
        });
    });
});
