import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export const repoRoot = join(__dirname, "..", "..", "..");

/**
 * The directories every pipeline hygiene guard reads.
 *
 * This lives in one place on purpose. Two guards -- the `set -euo pipefail`
 * check and the `GitHubComment@0` check -- need the same subject, and when each
 * carried its own copy of this list, widening one and not the other would have
 * left the second silently narrow while still reporting success. That is the
 * same defect both guards exist to prevent, one level up: a scope that reads
 * complete because nothing compares it to reality.
 *
 * `pipelineFilesInRepo()` below is the comparison to reality, and it is
 * asserted against this list so a new pipeline in a new directory fails by name
 * rather than quietly falling outside every guard in the repo.
 */
export const SCANNED_ROOTS: { dir: string; label: string; rootOnlyPattern: RegExp | null }[] = [
    // At the repository root, restrict to `azure-pipelines*.yml`: the root also
    // holds unrelated YAML (pnpm-lock.yaml chief among them) that is not a
    // pipeline and would only add noise.
    { dir: repoRoot, label: "", rootOnlyPattern: /^azure-pipelines.*\.ya?ml$/ },
    // `config/templates/` is included because those files are not
    // documentation -- the pipelines pull them in with `- template:`, so their
    // steps run as part of a pipeline and are subject to the same invariants.
    // They are unconditionally in scope; there is nothing else in that
    // directory.
    { dir: join(repoRoot, "config", "templates"), label: "config/templates", rootOnlyPattern: null },
    // GitHub Actions workflows run shell too. They were left out of the first
    // version of this list because "pipeline" was read as "Azure pipeline",
    // which is a convention of the files that happened to be in scope rather
    // than a property of the invariant. The pipefail invariant is a property of
    // bash, and it is live here: compat-sync-trigger.yml pipes `printf` into
    // `base64`, and Actions runs `run:` steps under `bash -e`, which sets
    // `errexit` but *not* `pipefail`. So a failure on the left of that pipe is
    // discarded exactly as it was in the seven Azure steps this PR fixes. The
    // step is correct today by the author's diligence, not by enforcement --
    // which is the state this file exists to convert into a guarantee.
    { dir: join(repoRoot, ".github", "workflows"), label: ".github/workflows", rootOnlyPattern: null },
];

/**
 * Every pipeline YAML file inside {@link SCANNED_ROOTS}, each tagged with the
 * repo-relative path a guard should report on failure and the root it came
 * from, so a guard can assert per-root coverage rather than a single total.
 */
export function pipelineYamlFiles(): { path: string; location: string; root: string }[] {
    const files: { path: string; location: string; root: string }[] = [];
    for (const { dir, label, rootOnlyPattern } of SCANNED_ROOTS) {
        for (const name of readdirSync(dir)) {
            if (!/\.ya?ml$/.test(name)) {
                continue;
            }
            if (rootOnlyPattern && !rootOnlyPattern.test(name)) {
                continue;
            }
            files.push({ path: join(dir, name), location: label ? `${label}/${name}` : name, root: label || "<repo root>" });
        }
    }
    return files;
}

/**
 * Every YAML file in the repository that declares CI steps, found by walking
 * the tree rather than by trusting a path convention.
 *
 * The predicate matches two dialects. Azure declares steps as list items
 * (`- script:`, `- task:`, `- bash:`). GitHub Actions is *not* reliably
 * expressible that way: its steps lead with `- name:` and put `run:` on a
 * following line with no dash, so a list-item pattern misses them entirely.
 * That is how the first version of this function returned 9 files while a
 * tenth sat in `.github/workflows/` -- the discovery predicate had been fitted
 * to the conventions of the files already in scope, and so could not find the
 * one that was not. Actions files are therefore identified by `runs-on:`,
 * which every Actions job has and no Azure file in this repo contains.
 *
 * Deliberately narrow beyond that: matching a bare `script:` or `run:` at any
 * indent would pull in unrelated YAML and turn the closure check into one that
 * misfires on valid files -- the failure mode that gets a guard deleted rather
 * than fixed. Verified to select exactly the ten CI files and to reject
 * pnpm-lock.yaml, config/browserstack.yml and the issue template.
 */
export function pipelineFilesInRepo(): string[] {
    const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite", "lab"]);
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (skip.has(entry)) {
                continue;
            }
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.ya?ml$/.test(entry)) {
                continue;
            }
            const text = readFileSync(full, "utf8");
            if (/^\s*-\s+(script|task|bash):/m.test(text) || /^\s*runs-on:/m.test(text)) {
                found.push(relative(repoRoot, full));
            }
        }
    };

    walk(repoRoot);
    return found.sort();
}
