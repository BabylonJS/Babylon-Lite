import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TEST_ROOT = join(REPO_ROOT, "tests");
const IMPORT_RE = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
const LEGACY_PARTICLE_MODULE_RE = /\/particle\/(?:particle(?:-system|-billboard)?|node\/(?:npe-build(?:-state)?|npe-registry|blocks\/.+))$/;

function* walkTypescript(directory: string): Generator<string> {
    for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const stats = statSync(path);
        if (stats.isDirectory()) {
            yield* walkTypescript(path);
        } else if (stats.isFile() && name.endsWith(".ts")) {
            yield path;
        }
    }
}

describe("particle test ownership", () => {
    it("does not import deletion-only object particle modules", () => {
        const offenders: string[] = [];
        for (const path of walkTypescript(TEST_ROOT)) {
            const source = readFileSync(path, "utf8");
            for (const match of source.matchAll(IMPORT_RE)) {
                const specifier = match[1]!.replace(/\.(?:js|ts)$/, "");
                if (LEGACY_PARTICLE_MODULE_RE.test(specifier)) {
                    offenders.push(`${relative(REPO_ROOT, path).split(sep).join("/")}: ${match[1]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
