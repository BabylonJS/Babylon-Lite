import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const pipelineFiles = ["azure-pipelines.yml", "azure-pipelines-bundle-manifest.yml"];
const cachePath = "$(System.DefaultWorkingDirectory)/.bundle-asset-cache";

function uniqueLine(lines: string[], value: string, label: string): number {
    const matches = lines.flatMap((line, index) => (line.trim() === value ? [index] : []));
    expect(matches, label).toHaveLength(1);
    return matches[0] ?? -1;
}

function nextStep(lines: string[], after: number): number {
    return lines.findIndex((line, index) => index > after && /^\s*-\s+\S/.test(line));
}

function previousLine(lines: string[], before: number, value: string): number {
    for (let index = before - 1; index >= 0; index--) {
        if (lines[index]?.trim() === value) {
            return index;
        }
    }
    return -1;
}

describe("remote scene asset cache pipelines", () => {
    it.each(pipelineFiles)("%s creates the cache directory before Cache@2 registers its post-job save", (pipelineFile) => {
        const lines = readFileSync(join(repoRoot, pipelineFile), "utf8").split(/\r?\n/);
        const initScript = uniqueLine(lines, `- script: mkdir -p "${cachePath}"`, `${pipelineFile} must initialize the cache path exactly once`);
        const initDisplayName = uniqueLine(lines, 'displayName: "Initialize remote scene asset cache"', `${pipelineFile} must identify the cache initialization step exactly once`);
        const cacheDisplayName = uniqueLine(lines, 'displayName: "Cache remote scene assets"', `${pipelineFile} must declare one remote scene cache`);
        const cacheTask = previousLine(lines, cacheDisplayName, "- task: Cache@2");
        const cachePathInput = uniqueLine(lines, `path: ${cachePath}`, `${pipelineFile} must cache the initialized path`);

        expect(initDisplayName).toBeGreaterThan(initScript);
        expect(lines.slice(initScript, cacheTask).some((line) => /^\s*condition\s*:/.test(line))).toBe(false);
        expect(nextStep(lines, initScript)).toBe(cacheTask);
        expect(cacheTask).toBeGreaterThan(initDisplayName);
        expect(cachePathInput).toBeGreaterThan(cacheDisplayName);
    });
});
