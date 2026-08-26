import { describe, expect, it } from "vitest";

import { stampCeilings } from "../../../scripts/publish-bundle-baseline";

/**
 * The publisher stamps each measured scene with the ceiling it was measured
 * against, so a consumer never has to reconstruct that number from its own
 * working tree. See scripts/publish-bundle-baseline.ts for why.
 */
describe("stampCeilings", () => {
    const manifest = {
        scene1: { rawKB: 12.3, rawBytes: 12595, gzipKB: 4.5 },
        scene2: { rawKB: 40, rawBytes: 40960, gzipKB: 12 },
    };

    it("records the ceiling beside the measurement it applies to", () => {
        const stamped = stampCeilings(manifest, [
            { id: 1, maxRawKB: 13 },
            { id: 2, maxRawKB: 41 },
        ]);

        expect(stamped.scene1?.ceilingKB).toBe(13);
        expect(stamped.scene2?.ceilingKB).toBe(41);
    });

    it("leaves the measured numbers untouched", () => {
        // Stamping is additive. If it ever rewrote a measurement, every delta
        // computed against the baseline would be wrong in a way that looks like a
        // real size change.
        const stamped = stampCeilings(manifest, [{ id: 1, maxRawKB: 13 }]);

        expect(stamped.scene1).toEqual({ rawKB: 12.3, rawBytes: 12595, gzipKB: 4.5, ceilingKB: 13 });
    });

    it("does not mutate the manifest it was given", () => {
        const input = { scene1: { rawKB: 12.3, gzipKB: 4.5 } };
        stampCeilings(input, [{ id: 1, maxRawKB: 13 }]);

        expect(input.scene1).toEqual({ rawKB: 12.3, gzipKB: 4.5 });
    });

    it("omits a ceiling for a scene that opts out of the bundle-size check", () => {
        // scene-config.json carries a stale maxRawKB on at least one skipped scene,
        // so honouring skipBundleSize matters: publishing that number would let a
        // consumer report a breach the check itself does not enforce.
        const stamped = stampCeilings(manifest, [
            { id: 1, maxRawKB: 13, skipBundleSize: true },
            { id: 2, maxRawKB: 41 },
        ]);

        expect(stamped.scene1?.ceilingKB).toBeUndefined();
        expect(stamped.scene2?.ceilingKB).toBe(41);
    });

    it("omits a ceiling for a scene that has none configured", () => {
        const stamped = stampCeilings(manifest, [{ id: 1 }, { id: 2, maxRawKB: 41 }]);

        expect(stamped.scene1?.ceilingKB).toBeUndefined();
        expect("ceilingKB" in stamped.scene1!).toBe(false);
    });

    it("keeps scenes that scene-config.json says nothing about", () => {
        // Dropping them would silently shrink the baseline, and a scene missing from
        // the baseline reads as "new in this PR" rather than as an omission.
        const stamped = stampCeilings(manifest, []);

        expect(Object.keys(stamped)).toEqual(["scene1", "scene2"]);
    });

    it("stays readable by the manifest validator already deployed everywhere", () => {
        // Every open PR and every dev clone runs today's isBundleManifest, which
        // requires a numeric rawKB on *every* top-level value. A stamped baseline
        // they cannot parse would blank the bundle delta repo-wide at once, which is
        // the outage publishing the baseline was introduced to end.
        const stamped = stampCeilings(manifest, [{ id: 1, maxRawKB: 13 }]);
        const entries = Object.values(stamped);

        expect(entries.length > 0 && entries.every((entry) => typeof entry === "object" && entry !== null && typeof entry.rawKB === "number")).toBe(true);
    });
});
