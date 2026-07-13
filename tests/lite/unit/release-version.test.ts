import { describe, expect, it } from "vitest";

import { bumpVersion, detectBreakingChanges, parseReleaseType, resolveReleaseType } from "../../../scripts/release-version";

describe("release version resolution", () => {
    describe("resolveReleaseType — auto never emits a major", () => {
        it("resolves auto to minor even when breaking changes are present", () => {
            // Regression guard for the accidental 2.0.0 release: a breaking commit
            // on master must NOT let the scheduled/auto run self-promote to a major.
            expect(resolveReleaseType("auto")).toBe("minor");
        });

        it("resolves auto to minor when no breaking changes are present", () => {
            expect(resolveReleaseType("auto")).toBe("minor");
        });

        it("passes explicit requests through unchanged", () => {
            expect(resolveReleaseType("patch")).toBe("patch");
            expect(resolveReleaseType("minor")).toBe("minor");
            // A major is still possible, but only when a human requests it explicitly.
            expect(resolveReleaseType("major")).toBe("major");
        });
    });

    describe("bumpVersion", () => {
        it("bumps a minor release", () => {
            expect(bumpVersion("1.10.0", "minor")).toBe("1.11.0");
        });

        it("bumps a patch release", () => {
            expect(bumpVersion("1.10.0", "patch")).toBe("1.10.1");
        });

        it("bumps a major release", () => {
            expect(bumpVersion("1.10.0", "major")).toBe("2.0.0");
        });
    });

    describe("auto + breaking on the 1.x line stays on 1.x", () => {
        it("resolves 1.10.0 to 1.11.0 for an auto release with breaking changes", () => {
            const resolved = resolveReleaseType("auto");
            expect(bumpVersion("1.10.0", resolved)).toBe("1.11.0");
        });
    });

    describe("detectBreakingChanges", () => {
        it("detects a bang marker in a conventional-commit subject", () => {
            expect(detectBreakingChanges("feat(storage)!: add managed storage buffers")).toBe(true);
        });

        it("detects a BREAKING CHANGE footer", () => {
            expect(detectBreakingChanges("feat: something\n\nBREAKING CHANGE: describe the migration")).toBe(true);
        });

        it("detects a BREAKING-CHANGE (hyphenated) footer", () => {
            expect(detectBreakingChanges("BREAKING-CHANGE: hyphenated variant")).toBe(true);
        });

        it("returns false for non-breaking commits", () => {
            expect(detectBreakingChanges("feat: add feature\nfix: correct a bug\nchore: tidy up")).toBe(false);
        });
    });

    describe("parseReleaseType", () => {
        it("accepts the four supported values", () => {
            expect(parseReleaseType("auto")).toBe("auto");
            expect(parseReleaseType("patch")).toBe("patch");
            expect(parseReleaseType("minor")).toBe("minor");
            expect(parseReleaseType("major")).toBe("major");
        });

        it("rejects unknown values", () => {
            expect(() => parseReleaseType("nightly")).toThrow();
        });
    });
});
