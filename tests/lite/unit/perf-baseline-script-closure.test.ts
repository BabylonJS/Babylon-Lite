import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS_DIR = resolve(ROOT, "scripts");
const PERF_BASELINE = resolve(SCRIPTS_DIR, "build-perf-baseline.ts");
const ENTRY = "bundle-scenes-core.ts";

/**
 * `build-perf-baseline.ts` checks the baseline ref out into a worktree and then copies
 * a hand-maintained list of `scripts/` files over it, so the baseline is measured with
 * the *current* bundle builder rather than a historical one.
 *
 * That list is a manual mirror of an import graph, which is exactly the kind of coupling
 * that rots silently: extracting a helper out of bundle-scenes-core.ts leaves the list
 * stale, and nothing complains until the perf job — the slowest job in the pipeline, and
 * one that only runs in CI — dies with "Cannot find module './<helper>'". Every other
 * consumer builds from a full checkout where the file is simply present, so local runs,
 * unit tests, and the bundle-size job all stay green while perf is broken.
 *
 * This test closes that gap statically: it recomputes the import closure from the source
 * and fails in milliseconds, at the moment the helper is extracted.
 */
function relativeImportsOf(fileName: string): string[] {
    const source = readFileSync(resolve(SCRIPTS_DIR, fileName), "utf8");
    // Strip comments first. bundle-scenes-core.ts documents its own re-export handling
    // with illustrative `export { A } from "./foo.js"` snippets inside doc comments, and
    // matching those would invent dependencies on files that never existed.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Matches `from "./x"` in both import and re-export position. Only same-directory
    // specifiers matter: the copy step is flat, so anything deeper would need a different
    // fix than adding a name to the list, and should fail loudly here rather than be
    // silently normalised into a passing assertion.
    const specifiers = [...code.matchAll(/\bfrom\s+"(\.\/[^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
    return specifiers.map((specifier) => {
        const bare = specifier.replace(/^\.\//, "").replace(/\.js$/, "");
        return bare.endsWith(".ts") ? bare : `${bare}.ts`;
    });
}

function importClosureOf(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);
        // Relative imports that don't resolve to a scripts/ file (e.g. a directory index)
        // are out of scope for the flat copy step; skip rather than crash.
        if (!existsSync(resolve(SCRIPTS_DIR, current))) continue;
        queue.push(...relativeImportsOf(current));
    }
    seen.delete(entry);
    return seen;
}

function copiedScriptList(): string[] {
    const source = readFileSync(PERF_BASELINE, "utf8");
    const match = source.match(/for\s*\(const scriptName of \[([\s\S]*?)\]\)/);
    const listBody = match?.[1];
    // A rename or refactor of the copy loop must fail loudly here. Silently returning an
    // empty list would make the closure assertion below pass for the wrong reason.
    expect(listBody, "could not locate the script copy list in build-perf-baseline.ts").toBeTruthy();
    return [...(listBody ?? "").matchAll(/"([^"]+)"/g)].flatMap((entry) => (entry[1] ? [entry[1]] : []));
}

describe("perf baseline script copy list", () => {
    it("includes every scripts/ module that the bundle builder imports", () => {
        const copied = copiedScriptList();
        const required = importClosureOf(ENTRY);

        const missing = [...required].filter((name) => !copied.includes(name));
        expect(
            missing,
            `build-perf-baseline.ts copies ${ENTRY} into the baseline worktree but not ${missing.join(", ")}. ` +
                `The baseline ref predates these files, so the perf job fails with "Cannot find module". ` +
                `Add them to the copy list in scripts/build-perf-baseline.ts.`
        ).toEqual([]);
    });

    it("copies the bundle builder itself", () => {
        // The closure check above is vacuous if the entry point ever drops off the list.
        expect(copiedScriptList()).toContain(ENTRY);
    });
});
