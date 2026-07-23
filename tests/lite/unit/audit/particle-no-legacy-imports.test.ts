import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCE_ROOT = join(REPO_ROOT, "packages", "babylon-lite", "src");
const TEST_ROOT = join(REPO_ROOT, "tests");
const RETIRED_PARTICLE_ROOT = join(SOURCE_ROOT, "particle", "soa");
const IMPORT_RE = /\b(?:from\s+|import\s*(?:\(\s*)?)(["'])([^"']+)\1/g;
const RETIRED_PARTICLE_PATH_RE = /\/particle\/soa(?:\/|$)/;

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

describe("particle module ownership", () => {
    it("does not restore the retired particle/soa path", () => {
        expect(existsSync(RETIRED_PARTICLE_ROOT)).toBe(false);

        const offenders: string[] = [];
        for (const root of [SOURCE_ROOT, TEST_ROOT]) {
            for (const path of walkTypescript(root)) {
                const source = readFileSync(path, "utf8");
                for (const match of source.matchAll(IMPORT_RE)) {
                    const specifier = match[2]!.replace(/\.(?:js|ts)$/, "");
                    if (RETIRED_PARTICLE_PATH_RE.test(specifier)) {
                        offenders.push(`${relative(REPO_ROOT, path).split(sep).join("/")}: ${match[2]}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
