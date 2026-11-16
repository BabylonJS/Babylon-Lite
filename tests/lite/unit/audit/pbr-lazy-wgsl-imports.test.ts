import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..", "..", "..", "packages", "babylon-lite", "src");
// PBR WGSL modules that pbr-renderable loads with `await import()` only when a mesh of the group needs
// them. A single static import anywhere in the library would pull them back into every PBR bundle.
const LAZY_PBR_WGSL = ["pbr-normal-tangent-wgsl", "pbr-normal-cotangent-wgsl", "pbr-spec-gloss-wgsl"];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
}

describe("lazy PBR WGSL modules", () => {
    it("are never imported statically (type-only imports excepted)", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(SRC_ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const name of LAZY_PBR_WGSL) {
                const staticImport = new RegExp(`^\\s*(?:import|export)\\s+(?!type\\b)[^;]*?from\\s+["'][^"']*/${name}(?:\\.js)?["']`, "m");
                if (staticImport.test(source)) {
                    offenders.push(`${file} -> ${name}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("are loaded dynamically by the PBR group build", () => {
        const renderable = readFileSync(join(SRC_ROOT, "material", "pbr", "pbr-renderable.ts"), "utf8");
        for (const name of LAZY_PBR_WGSL) {
            expect(renderable).toContain(`await import("./fragments/${name}.js")`);
        }
    });
});
