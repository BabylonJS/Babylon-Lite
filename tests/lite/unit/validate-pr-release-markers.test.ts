import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

describe("release marker PR metadata fetch", () => {
    it("retries a transient GitHub server error before validating the PR", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "release-marker-retry-"));
        const preloadPath = join(tempDir, "mock-github-fetch.mjs");
        writeFileSync(
            preloadPath,
            `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
require("node:child_process").execFileSync = () => "feat: test";
syncBuiltinESMExports();
let attempts = 0;
globalThis.fetch = async () => {
    attempts++;
    console.log("MOCK_GITHUB_ATTEMPT=" + attempts);
    if (attempts === 1) {
        return new Response(
            new ReadableStream({
                cancel() {
                    console.log("MOCK_GITHUB_BODY_CANCELLED");
                },
            }),
            { status: 503, statusText: "Service Unavailable" }
        );
    }
    return new Response(JSON.stringify({ title: "feat: test", body: "", labels: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};
`
        );

        try {
            const result = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preloadPath).href, resolve("scripts/validate-pr-release-markers.ts")], {
                cwd: resolve("."),
                encoding: "utf8",
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: "BabylonJS/Babylon-Lite",
                    PR_NUMBER: "421",
                    GITHUB_TOKEN: "test-token",
                },
            });

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain("MOCK_GITHUB_ATTEMPT=1");
            expect(result.stdout).toContain("MOCK_GITHUB_ATTEMPT=2");
            expect(result.stdout).toContain("MOCK_GITHUB_BODY_CANCELLED");
            expect(result.stdout).toContain("No breaking-change marker detected");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
