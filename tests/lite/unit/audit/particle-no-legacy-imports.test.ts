import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const RETIRED_PARTICLE_ROOT = join(REPO_ROOT, "packages", "babylon-lite", "src", "particle", "soa");
const UNIT_TEST_ROOT = join(__dirname, "..");

describe("particle module ownership", () => {
    it("does not restore retired source or test paths", () => {
        expect(existsSync(RETIRED_PARTICLE_ROOT)).toBe(false);
        expect(readdirSync(UNIT_TEST_ROOT).filter((name) => /^particle-soa.*\.test\.ts$/.test(name))).toEqual([]);
    });
});
