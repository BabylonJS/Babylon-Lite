import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, ensureLibBuilt, LIB_ENTRY, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

describe("animation curve editing tree shaking", () => {
    it("adds no bytes to ordinary animation consumers, even with unused editor imports", async () => {
        const common = "createPropertyAnimationClip, createPropertyAnimationGroup, createAnimationGroups, goToFrame";
        const body = "console.log(createPropertyAnimationClip, createPropertyAnimationGroup, createAnimationGroups, goToFrame);";
        const baseline = await runRollup({ entrySource: `import { ${common} } from ${JSON.stringify(LIB_ENTRY)};\n${body}`, format: "es", minify: false });
        const unused = await runRollup({
            entrySource: `import { ${common}, getAnimationGroupTracks, setAnimationTrackKeys } from ${JSON.stringify(LIB_ENTRY)};\n${body}`,
            format: "es",
            minify: false,
        });
        expect(baseline.errors).toEqual([]);
        expect(unused.errors).toEqual([]);
        expect(baseline.significantWarnings).toEqual([]);
        expect(unused.significantWarnings).toEqual([]);
        expect(unused.code).toBe(baseline.code);
        expect(baseline.code).not.toContain("function getAnimationGroupTracks");
        expect(baseline.code).not.toContain("function setAnimationTrackKeys");
    });

    it("includes the editor when explicitly used", async () => {
        const result = await runRollup({
            entrySource: `export { getAnimationGroupTracks, setAnimationTrackKeys } from ${JSON.stringify(LIB_ENTRY)};`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code).toContain("function getAnimationGroupTracks");
        expect(result.code).toContain("function setAnimationTrackKeys");
    });
});
