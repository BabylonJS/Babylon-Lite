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
];

/**
 * Every pipeline YAML file inside {@link SCANNED_ROOTS}, each tagged with the
 * repo-relative path a guard should report on failure.
 */
export function pipelineYamlFiles(): { path: string; location: string }[] {
    const files: { path: string; location: string }[] = [];
    for (const { dir, label, rootOnlyPattern } of SCANNED_ROOTS) {
        for (const name of readdirSync(dir)) {
            if (!/\.ya?ml$/.test(name)) {
                continue;
            }
            if (rootOnlyPattern && !rootOnlyPattern.test(name)) {
                continue;
            }
            files.push({ path: join(dir, name), location: label ? `${label}/${name}` : name });
        }
    }
    return files;
}

/**
 * Every YAML file in the repository that declares Azure Pipelines steps, found
 * by walking the tree rather than by trusting a path convention.
 *
 * The predicate is the list-item step form (`- script:`, `- task:`, `- bash:`),
 * which is how ADO steps are written. Deliberately narrow: matching a bare
 * `script:` anywhere would pull in unrelated YAML and turn the closure check
 * into one that misfires on valid files -- the failure mode that gets a guard
 * deleted rather than fixed. Verified to select exactly the nine pipeline files
 * and to reject pnpm-lock.yaml, config/browserstack.yml, the GitHub Actions
 * workflow (which uses `run:`, not `script:`) and the issue template.
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
            if (/^\s*-\s+(script|task|bash):/m.test(readFileSync(full, "utf8"))) {
                found.push(relative(repoRoot, full));
            }
        }
    };

    walk(repoRoot);
    return found.sort();
}
