import { describe, expect, it } from "vitest";
import { parseShadoSceneSelection } from "../parity-shado/scene-selection";

const knownSceneIds = new Set([5, 40, 171]);

describe("parseShadoSceneSelection", () => {
    it("uses null only when SHADO_SCENES is unset", () => {
        expect(parseShadoSceneSelection(undefined, knownSceneIds)).toBeNull();
    });

    it("keeps an explicitly empty selection empty", () => {
        expect(parseShadoSceneSelection("  ", knownSceneIds)).toEqual(new Set());
    });

    it("parses and deduplicates known scene IDs", () => {
        expect(parseShadoSceneSelection("5, 40,5", knownSceneIds)).toEqual(new Set([5, 40]));
    });

    it.each(["nope", "5,,40", "5.5", "999"])("rejects invalid or unknown selection %s", (value) => {
        expect(() => parseShadoSceneSelection(value, knownSceneIds)).toThrow(/invalid or unknown scene IDs/);
    });
});
