import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const repoRoot = join(__dirname, "..", "..", "..");
const docPath = join(repoRoot, "TESTING.md");
const sectionHeading = "### Required Pipeline Variable Groups";

/**
 * Every `- group:` an Azure pipeline imports, keyed by the file importing it.
 */
function declaredGroups(): Map<string, string[]> {
    const byGroup = new Map<string, string[]>();
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // Guard the guard: if the glob ever stops matching, an empty declared set
    // would make every assertion below vacuously true. That is the exact
    // failure mode this file exists to prevent, so it must not be possible here.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
        for (const line of readFileSync(join(repoRoot, file), "utf8").split("\n")) {
            const match = /^\s*-\s*group:\s*(\S+)\s*$/.exec(line);
            const group = match?.[1];
            if (!group) {
                continue;
            }
            byGroup.set(group, [...(byGroup.get(group) ?? []), file]);
        }
    }

    // And guard it one level deeper. Finding the files is not the same as
    // parsing them: if the `- group:` pattern ever stops matching, the map is
    // empty, "every declared group is documented" is trivially satisfied, and
    // the primary assertion reports success having checked nothing. Verified by
    // breaking the pattern on purpose -- without this line that test passes.
    expect(byGroup.size, "parsed no `- group:` declarations — the assertions would be vacuous").toBeGreaterThan(0);

    return byGroup;
}

/** Repo-relative paths of the files `declaredGroups()` actually reads. */
function scannedFiles(): string[] {
    return readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));
}

/**
 * Every YAML file in the repository, as repo-relative paths.
 *
 * Discovered by walking rather than listed, because a list is the thing under
 * test. `scannedFiles()` reads the repo root only, which is correct today for a
 * reason that is easy to mistake for luck: variable groups are valid solely in a
 * pipeline/stage/job `variables:` block, and both files under `config/templates`
 * are pure step templates, so they *cannot* declare one. That is a structural
 * argument, not a placement one -- but it stops holding the moment someone
 * converts a step template into a job template, or adds a pipeline in a new
 * directory, and nothing about that change would look like it touched this test.
 */
function allYamlFiles(): string[] {
    const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", "out", ".turbo"]);
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            if (skip.has(name)) {
                continue;
            }
            const full = join(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (/\.ya?ml$/.test(name)) {
                found.push(relative(repoRoot, full).split(sep).join("/"));
            }
        }
    };
    walk(repoRoot);

    // Guard the collector. A walk that silently returns nothing would make the
    // closure assertion below pass having compared two empty sets.
    expect(found.length, "walked the repo and found no YAML at all").toBeGreaterThan(0);
    return found;
}

/**
 * The body of the required-groups section only. Scoping to the section is the
 * whole point: TESTING.md mentions these group names in surrounding prose, so
 * searching the entire file would let an incidental mention satisfy the check
 * and turn this into a test that runs but cannot fail.
 */
function documentedSection(): string {
    const doc = readFileSync(docPath, "utf8");
    const start = doc.indexOf(sectionHeading);
    expect(start, `${sectionHeading} not found in TESTING.md`).toBeGreaterThanOrEqual(0);

    const after = start + sectionHeading.length;
    const next = doc.indexOf("\n### ", after);
    return doc.slice(after, next === -1 ? doc.length : next);
}

describe("pipeline variable groups are documented", () => {
    // An incomplete list here is not a documentation nit. The bundle-manifest
    // pipeline was written against a version of this section that omitted
    // BabylonJS-CI-Infrastructure, so it imported two of the three groups it
    // needed. Azure does not fail a pipeline for a group it was never told
    // about: the unresolved macro is passed through as literal text, the
    // upload posts an empty storage account, and the deploy server answers
    // 401 after the 28-minute measurement step has already succeeded.
    it("lists every group imported by an azure-pipelines file", () => {
        const section = documentedSection();
        const undocumented = [...declaredGroups().entries()].filter(([group]) => !section.includes(group)).map(([group, files]) => `${group} (imported by ${files.join(", ")})`);

        expect(undocumented, `Undocumented variable group(s). Add them to "${sectionHeading}" in TESTING.md.`).toEqual([]);
    });

    // The reverse direction, so the list cannot rot in the other direction:
    // a group that no pipeline imports is a name a reader may propagate into
    // a new pipeline, which is how the original defect would recur inverted.
    it("does not list groups no azure-pipelines file imports", () => {
        const declared = declaredGroups();
        const stale = [...documentedSection().matchAll(/`(BabylonJS-[A-Za-z0-9-]+|NPM_Publish)`/g)]
            .map((m) => m[1])
            .filter((group): group is string => group !== undefined)
            .filter((group, index, all) => all.indexOf(group) === index)
            .filter((group) => !declared.has(group));

        expect(stale, `Documented but unused variable group(s).`).toEqual([]);
    });

    // Coverage by placement is not coverage. The two assertions above are only
    // as wide as `scannedFiles()`, and nothing in them compares that list to
    // reality -- which is the same shape as the hand-maintained group list that
    // caused the 401 this PR fixes. Discover the subject, then assert the
    // configured scope covers it.
    //
    // Compared as repo-relative paths, never basenames: a future `ci/azure-
    // pipelines.yml` shares a basename with the root file and would read as
    // covered, a false negative hiding exactly the case this exists to catch.
    it("reads every file that declares a variable group", () => {
        const scanned = new Set(scannedFiles());
        const declaring = allYamlFiles().filter((file) => /^\s*-\s*group:/m.test(readFileSync(join(repoRoot, file), "utf8")));

        // Print N and the subject. "N things, all correct" means nothing if the
        // set silently emptied.
        console.log(`files declaring a variable group: ${declaring.length}`);
        for (const file of declaring) {
            console.log(`  ${file}`);
        }
        expect(declaring.length, "no file declares a `- group:` — the assertion below would be vacuous").toBeGreaterThan(0);

        const unscanned = declaring.filter((file) => !scanned.has(file));

        expect(unscanned, "these files declare a variable group but the guard never reads them, so a group they require can go undocumented:").toEqual([]);
    });
});
