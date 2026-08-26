import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface FixtureManifest {
    fixtures: { id: string; file: string; variant: "full" | "shapes"; reference?: "babylon" | "lottie-web"; loop?: boolean; urlSource?: boolean; features: string[] }[];
}

const visualDir = resolve(dirname(fileURLToPath(import.meta.url)), "visual");
const manifest = JSON.parse(readFileSync(resolve(visualDir, "fixtures/manifest.json"), "utf8")) as FixtureManifest;
const expected = [
    { id: "butt-caps", file: "butt-caps.json", variant: "shapes", reference: "lottie-web", loop: true },
    { id: "embedded-image", file: "embedded-image.json", variant: "full", reference: "lottie-web", loop: true },
    { id: "gradients", file: "gradients.json", variant: "shapes", reference: "babylon", loop: true },
    { id: "gradient-animation", file: "gradient-animation.json", variant: "shapes", reference: "lottie-web", loop: false },
    { id: "hidden-layer", file: "hidden-layer.json", variant: "shapes", reference: "lottie-web", loop: true },
    { id: "masks-matte", file: "masks-matte.json", variant: "shapes", reference: "lottie-web", loop: true },
    { id: "nested-group-transform", file: "nested-group-transform.json", variant: "shapes", reference: "lottie-web", loop: true },
    { id: "parenting-z-order", file: "parenting-z-order.json", variant: "full", reference: "babylon", loop: true },
    { id: "path-morph", file: "path-morph.json", variant: "shapes", reference: "lottie-web", loop: false },
    { id: "relative-image-url", file: "relative-image.json", variant: "full", reference: "lottie-web", loop: true, urlSource: true },
    { id: "strokes-and-fills", file: "strokes-and-fills.json", variant: "shapes", reference: "babylon", loop: true },
] as const;

describe("visual fixture inventory", () => {
    it("contains only local owned fixtures with matching reviewed goldens", () => {
        expect(manifest.fixtures.map((fixture) => fixture.id).sort()).toEqual(expected.map((fixture) => fixture.id).sort());
        expect(
            readdirSync(resolve(visualDir, "fixtures"))
                .filter((file) => file.endsWith(".json") && file !== "manifest.json")
                .sort()
        ).toEqual(expected.map((fixture) => fixture.file).sort());
        expect(readdirSync(resolve(visualDir, "reference")).sort()).toEqual(expected.map((fixture) => `${fixture.id}.png`).sort());
        expect(readdirSync(resolve(visualDir, "fixtures/images")).sort()).toEqual(["four-color.png.base64"]);
        expect(
            manifest.fixtures
                .map((fixture) => ({
                    id: fixture.id,
                    file: fixture.file,
                    variant: fixture.variant,
                    reference: fixture.reference ?? "babylon",
                    loop: fixture.loop ?? true,
                    urlSource: fixture.urlSource ?? false,
                }))
                .sort((a, b) => a.id.localeCompare(b.id))
        ).toEqual(expected.map((fixture) => ({ ...fixture, urlSource: "urlSource" in fixture ? fixture.urlSource : false })).sort((a, b) => a.id.localeCompare(b.id)));

        const ids = new Set<string>();
        for (const fixture of manifest.fixtures) {
            expect(fixture.file).toBe(basename(fixture.file));
            expect(fixture.file).toMatch(/^[a-z0-9-]+\.json$/);
            expect(fixture.features.length).toBeGreaterThan(0);
            expect(ids.has(fixture.id)).toBe(false);
            ids.add(fixture.id);

            const fixturePath = resolve(visualDir, "fixtures", fixture.file);
            const document = JSON.parse(readFileSync(fixturePath, "utf8")) as { nm?: string; layers?: unknown[] };
            expect(document.nm).toMatch(/^Babylon Lottie Player /);
            expect(document.layers?.length).toBeGreaterThan(0);
        }
    });
});
