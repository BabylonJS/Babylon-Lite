import { randomUUID } from "crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { browserStackCredentialsFromEnvironment, sanitizeArtifacts, type BrowserStackCredentials, verifyArtifacts } from "../../../scripts/redact-secrets";

const repoRoot = resolve(__dirname, "../../..");
const scriptPath = resolve(repoRoot, "scripts/redact-secrets.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];

function createTempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "artifact-security-"));
    tempDirs.push(directory);
    return directory;
}

function syntheticCredentials(): BrowserStackCredentials {
    const id = randomUUID();
    return {
        username: `ci-user-${id}@example.invalid`,
        accessKey: `synthetic-${id}+/=`,
    };
}

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("BrowserStack artifact security", () => {
    it("sanitizes raw credentials in nested artifacts", () => {
        const directory = createTempDir();
        const nested = join(directory, "report", "data");
        mkdirSync(nested, { recursive: true });
        const credentials = syntheticCredentials();
        const artifact = join(nested, "failure.json");
        writeFileSync(artifact, JSON.stringify({ endpoint: credentials.accessKey, owner: credentials.username }));

        const stats = sanitizeArtifacts([directory], credentials);
        verifyArtifacts([directory], credentials);

        const content = readFileSync(artifact, "utf8");
        expect(content).not.toContain(credentials.accessKey);
        expect(content).not.toContain(credentials.username);
        expect(stats.redactions).toBeGreaterThanOrEqual(2);
    });

    it("sanitizes URL-encoded and repeatedly encoded credentials", () => {
        const directory = createTempDir();
        const credentials = syntheticCredentials();
        const artifact = join(directory, "report.html");
        const encodedUsername = encodeURIComponent(credentials.username);
        const nestedAccessKey = encodeURIComponent(encodeURIComponent(credentials.accessKey));
        writeFileSync(artifact, `${encodedUsername}\n${nestedAccessKey}`);

        sanitizeArtifacts([artifact], credentials);
        verifyArtifacts([artifact], credentials);

        const content = readFileSync(artifact, "utf8");
        expect(content).not.toContain(encodedUsername);
        expect(content).not.toContain(nestedAccessKey);
    });

    it("recursively sanitizes credentials inside ZIP artifacts", () => {
        const directory = createTempDir();
        const credentials = syntheticCredentials();
        const tracePath = join(directory, "trace.zip");
        const nestedZip = zipSync({
            "nested.txt": strToU8(encodeURIComponent(credentials.username)),
        });
        writeFileSync(
            tracePath,
            zipSync({
                [`resources/${credentials.username}.txt`]: strToU8(credentials.accessKey),
                "nested.zip": nestedZip,
            })
        );

        const stats = sanitizeArtifacts([tracePath], credentials);
        verifyArtifacts([tracePath], credentials);

        const outer = unzipSync(readFileSync(tracePath));
        expect(Object.keys(outer).join("\n")).not.toContain(credentials.username);
        expect(strFromU8(outer["resources/".concat("*".repeat(credentials.username.length), ".txt")] ?? new Uint8Array())).not.toContain(credentials.accessKey);
        const nested = unzipSync(outer["nested.zip"] ?? new Uint8Array());
        expect(strFromU8(nested["nested.txt"] ?? new Uint8Array())).not.toContain(encodeURIComponent(credentials.username));
        expect(stats.archivesInspected).toBe(2);
    });

    it.each([
        ["raw", (credentials: BrowserStackCredentials) => credentials.accessKey],
        ["URL-encoded", (credentials: BrowserStackCredentials) => encodeURIComponent(credentials.username)],
    ])("verification rejects %s credentials before sanitization", (_label, secretValue) => {
        const directory = createTempDir();
        const credentials = syntheticCredentials();
        const artifact = join(directory, "report.txt");
        writeFileSync(artifact, secretValue(credentials));

        expect(() => verifyArtifacts([artifact], credentials)).toThrow("BrowserStack credentials remain");
    });

    it("leaves clean artifacts unchanged and verifies them", () => {
        const directory = createTempDir();
        const credentials = syntheticCredentials();
        const artifact = join(directory, "clean.bin");
        const clean = Buffer.from([0, 1, 2, 3, 255, 10, 13]);
        writeFileSync(artifact, clean);

        const stats = sanitizeArtifacts([artifact], credentials);
        verifyArtifacts([artifact], credentials);

        expect(readFileSync(artifact)).toEqual(clean);
        expect(stats.redactions).toBe(0);
    });

    it("fails closed when credentials or artifacts are unavailable", () => {
        const directory = createTempDir();
        const artifact = join(directory, "report.txt");
        writeFileSync(artifact, "clean");

        expect(() => sanitizeArtifacts([artifact], browserStackCredentialsFromEnvironment({}))).toThrow("credentials are unavailable");
        expect(() =>
            sanitizeArtifacts(
                [artifact],
                browserStackCredentialsFromEnvironment({
                    BROWSERSTACK_USERNAME: "$(BROWSERSTACK_USERNAME)",
                    BROWSERSTACK_ACCESS_KEY: "$(BROWSERSTACK_ACCESS_KEY)",
                })
            )
        ).toThrow("credentials are unavailable");
        expect(() => verifyArtifacts([join(directory, "missing")], syntheticCredentials())).toThrow("could not be inspected");
    });

    it("does not print credentials or matching artifact contents on failure", () => {
        const directory = createTempDir();
        const credentials = syntheticCredentials();
        const artifact = join(directory, "report.txt");
        const matchingContent = `private-content-${credentials.accessKey}`;
        writeFileSync(artifact, matchingContent);

        const result = spawnSync(process.execPath, [tsxPath, scriptPath, "verify", artifact], {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                BROWSERSTACK_USERNAME: credentials.username,
                BROWSERSTACK_ACCESS_KEY: credentials.accessKey,
            },
        });
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status).toBe(1);
        expect(output).not.toContain(credentials.username);
        expect(output).not.toContain(credentials.accessKey);
        expect(output).not.toContain(matchingContent);
    });
});

describe("BrowserStack pipeline publication gates", () => {
    const pipeline = readFileSync(resolve(repoRoot, "azure-pipelines.yml"), "utf8");
    const uploadTemplate = readFileSync(resolve(repoRoot, "config/templates/upload-test-report.yml"), "utf8");
    const parityConfig = readFileSync(resolve(repoRoot, "config/playwright.parity-cloud.config.ts"), "utf8");
    const perfConfig = readFileSync(resolve(repoRoot, "config/playwright.perf-cloud.config.ts"), "utf8");

    it("explicitly disables tracing in every BrowserStack Playwright config", () => {
        expect(parityConfig).toContain('trace: "off"');
        expect(perfConfig).toContain('trace: "off"');
    });

    it("sets ArtifactsSafe only after sanitize and verify commands", () => {
        const safetySteps = [...pipeline.matchAll(/npx tsx scripts\/redact-secrets\.ts sanitize[\s\S]*?##vso\[task\.setvariable variable=ArtifactsSafe\]true/g)];
        expect(safetySteps).toHaveLength(2);
        expect(pipeline.match(/ArtifactsSafe: "false"/g)).toHaveLength(2);
        for (const step of safetySteps) {
            expect(step[0]).toContain("redact-secrets.ts verify");
            expect(step[0]).not.toContain("continueOnError");
        }
    });

    it("gates BrowserStack result publication and allowlists only report directories", () => {
        for (const suite of ["perf", "parity"]) {
            expect(pipeline).toMatch(
                new RegExp(
                    `PublishTestResults@2\\s+condition: and\\(always\\(\\), eq\\(variables\\['ArtifactsSafe'\\], 'true'\\)\\)[\\s\\S]*?${suite}-junit\\.xml[\\s\\S]*?publishRunAttachments: false`
                )
            );
        }
        expect(uploadTemplate).toContain("condition: and(failed(), eq(variables['ArtifactsSafe'], 'true'))");
        expect(uploadTemplate).toContain("test-results/${{ parameters.reportType }}-report");
        expect(uploadTemplate).not.toContain("reportDir");
        expect(uploadTemplate).not.toContain("-artifacts");
    });
});
