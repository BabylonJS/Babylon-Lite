import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { comparisonPassSelection, parseSsaoComparisonConfig, SSAO_BASELINE, SSAO_COMPARISON_SCENES } from "../../../lab/lite/src/shared/ssao-comparison-contract.js";
import { comparisonBaselineImport, comparisonGitBlobHash, comparisonSizeExport } from "../../../scripts/ao-reference/comparison-baseline.js";

describe("matched SSAO comparison", () => {
    it("pins the unmerged baseline and all original algorithm modules", () => {
        expect(SSAO_BASELINE.commit).toMatch(/^[a-f0-9]{40}$/);
        expect(SSAO_BASELINE.pullRequest).toBe("https://github.com/BabylonJS/Babylon-Lite/pull/839");
        expect(Object.keys(SSAO_BASELINE.blobs)).toEqual(["screen-space-ambient-occlusion.ts", "screen-space-raymarch-wgsl.ts", "screen-space-temporal.ts"]);
        for (const hash of Object.values(SSAO_BASELINE.blobs)) {
            expect(hash).toMatch(/^[a-f0-9]{40}$/);
        }
        expect(comparisonGitBlobHash(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    });
    it("keeps local baseline dependencies pinned and shares only current engine helpers", () => {
        const root = resolve("comparison-fixture"),
            snapshot = resolve(root, "cache", SSAO_BASELINE.commit);
        const importer = resolve(snapshot, "post-process", "screen-space-ambient-occlusion.ts");
        expect(comparisonBaselineImport(root, snapshot, "./screen-space-temporal.js", importer)).toBe(resolve(snapshot, "post-process", "screen-space-temporal.ts"));
        expect(comparisonBaselineImport(root, snapshot, "../engine/render-target.js", importer)).toBe(
            resolve(root, "packages", "babylon-lite", "src", "engine", "render-target.ts")
        );
        expect(comparisonBaselineImport(root, snapshot, "babylon-lite", importer)).toBeNull();
        expect(comparisonBaselineImport(root, snapshot, "./unrelated.js", resolve(root, "outside.ts"))).toBeNull();
        expect(() => comparisonBaselineImport(root, snapshot, "../../../../outside.js", importer)).toThrow("escaped");
    });
    it("exposes the existing private size resolver only in the comparison build", () => {
        const source = "function resolveSize(desc) { return desc.size; }";
        expect(comparisonSizeExport(source)).toBe(`${source}\nexport { resolveSize as _resolveRenderTargetSize };\n`);
        expect(() => comparisonSizeExport("function changed() {}")).toThrow("compatibility seam");
        const exported = "export function _resolveRenderTargetSize(desc) { return desc; }";
        expect(comparisonSizeExport(exported)).toBe(exported);
    });
    it("defaults to shared-UV split preview with matched history limits", () => {
        const config = parseSsaoComparisonConfig(new URLSearchParams());
        expect(config).toMatchObject({
            scene: "contacts",
            mode: "split",
            algorithm: "current",
            enabled: true,
            half: true,
            reconstruction: "full",
            pruning: true,
            temporal: true,
            normals: true,
            quality: "high",
            radius: 0.6,
            intensity: 0.5,
        });
        expect(comparisonPassSelection(config)).toEqual({ current: true, existing: true, geometry: true, color: false, timing: false });
        expect(SSAO_COMPARISON_SCENES.map((scene) => scene.id)).toEqual(["contacts", "layers", "motion", "cornell", "kitchen"]);
    });
    it.each([0, 0.5, 1])("preserves an explicit comparison intensity of %s", (intensity) => {
        expect(parseSsaoComparisonConfig(new URLSearchParams(`intensity=${intensity}`)).intensity).toBe(intensity);
    });
    it("allows explicit unpruned transport without changing quality or resolution", () => {
        expect(parseSsaoComparisonConfig(new URLSearchParams("pruning=0"))).toMatchObject({ pruning: false, quality: "high", half: true, temporal: true });
    });
    it("keeps reduced reconstruction explicit and independent of spatial quality", () => {
        expect(parseSsaoComparisonConfig(new URLSearchParams("reconstruction=half"))).toMatchObject({ reconstruction: "half", half: true, quality: "high" });
    });
    it("times only the selected algorithm and the minimal matching producer", () => {
        const config = parseSsaoComparisonConfig(new URLSearchParams("mode=single&algorithm=existing"));
        expect(comparisonPassSelection(config)).toEqual({ current: false, existing: true, geometry: false, color: true, timing: true });
        config.algorithm = "current";
        expect(comparisonPassSelection(config)).toEqual({ current: true, existing: false, geometry: true, color: false, timing: true });
        config.normals = config.temporal = false;
        expect(comparisonPassSelection(config)).toEqual({ current: true, existing: false, geometry: false, color: true, timing: true });
    });
    it.each(["mode=split&algorithm=current", "mode=single&algorithm=current", "mode=single&algorithm=existing"])("bypasses every AO/input-MRT task when disabled: %s", (query) => {
        const config = parseSsaoComparisonConfig(new URLSearchParams(`${query}&ssao=0`));
        expect(config.enabled).toBe(false);
        expect(comparisonPassSelection(config)).toEqual({ current: false, existing: false, geometry: false, color: true, timing: config.mode === "single" });
        config.enabled = true;
        expect(comparisonPassSelection(config).current || comparisonPassSelection(config).existing).toBe(true);
    });
    it.each([
        "scene=other",
        "algorithm=other",
        "mode=other",
        "quality=other",
        "reconstruction=other",
        "temporal=true",
        "ssao=false",
        "ssao=",
        "normals=",
        "half=2",
        "pruning=2",
        "radius=NaN",
        "radius=0",
        "radius=3",
        "intensity=",
        "intensity=2",
    ])("rejects ambiguous or invalid configuration: %s", (query) => {
        expect(() => parseSsaoComparisonConfig(new URLSearchParams(query))).toThrow();
    });
});
