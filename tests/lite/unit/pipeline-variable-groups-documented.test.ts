import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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
    return byGroup;
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
        const stale = [...documentedSection().matchAll(/`(BabylonJS-[A-Za-z0-9-]+)`/g)]
            .map((m) => m[1])
            .filter((group): group is string => group !== undefined)
            .filter((group, index, all) => all.indexOf(group) === index)
            .filter((group) => !declared.has(group));

        expect(stale, `Documented but unused variable group(s).`).toEqual([]);
    });
});
