import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("../../../config/browserstack-cdp", () => ({
    buildBrowserStackEndpoint: () => "wss://example.invalid/webgpu-tests",
}));

beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CI", "true");
    vi.stubEnv("BROWSERSTACK_USERNAME", "");
    vi.stubEnv("BROWSERSTACK_ACCESS_KEY", "");
    vi.stubEnv("LAB_TEST_PORT", undefined);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

async function loadConfig() {
    return (await import("../../../config/playwright.integration-cloud.config")).default;
}

describe("nonvisual WebGPU integration CI", () => {
    it("selects only the two GPU readback specs without enabling media capture", async () => {
        const config = await loadConfig();
        expect(config.testDir).toBe("../tests/lite/integration");
        expect(config.testMatch).toEqual(["gaussian-point-reprojection.spec.ts", "gaussian-point-sampling.spec.ts"]);
        expect(config.workers).toBe(1);
        expect(config.forbidOnly).toBe(true);
        expect(config.use).toMatchObject({
            headless: true,
            trace: "off",
            screenshot: "off",
            video: "off",
            baseURL: "http://localhost:5179",
            channel: "chrome",
            launchOptions: { args: expect.arrayContaining(["--enable-unsafe-webgpu", "--use-vulkan=swiftshader"]) },
        });
        expect(config.reporter).toEqual([["list"], ["junit", { outputFile: "../test-results/webgpu-integration-junit.xml" }]]);
        expect(config.webServer).toMatchObject({
            command: "pnpm --filter @babylon-lite/lab dev",
            port: 5179,
            env: { LAB_DEV_PORT: "5179" },
            reuseExistingServer: false,
        });
    });

    it("uses the existing cloud CDP browser and Local tunnel with credentials", async () => {
        vi.stubEnv("BROWSERSTACK_USERNAME", "test-user");
        vi.stubEnv("BROWSERSTACK_ACCESS_KEY", "test-key");
        vi.stubEnv("CIWORKERS", "2");
        const config = await loadConfig();
        expect(config.globalSetup).toBe("./browserstack-local-tunnel.ts");
        expect(config.use?.connectOptions).toEqual({ wsEndpoint: "wss://example.invalid/webgpu-tests" });
        expect(config.use?.channel).toBeUndefined();
        expect(config.use?.launchOptions).toBeUndefined();
        expect(config.workers).toBe(1);
    });

    it("keeps the server port and navigation origin aligned for overrides", async () => {
        vi.stubEnv("LAB_TEST_PORT", "6187");
        const config = await loadConfig();
        expect(config.use?.baseURL).toBe("http://localhost:6187");
        expect(config.webServer).toMatchObject({ port: 6187, env: { LAB_DEV_PORT: "6187" } });
    });

    it("runs independently in PR CI and publishes only verified JUnit results", () => {
        const root = resolve(__dirname, "../../..");
        const pipeline = readFileSync(resolve(root, "azure-pipelines.yml"), "utf8");
        const job = pipeline.split(/^ {10}- job: WebGPUIntegration\r?\n/m)[1]?.split(/^ {10}- job:/m)[0];
        expect(job, "WebGPUIntegration job must be declared in the PR pipeline").toBeDefined();
        expect(job).toContain("bash scripts/browserstack-wait.sh pnpm test:integration-cloud");
        expect(job).toContain('BSTACK_SESSIONS_REQUIRED: "1"');
        expect(job).toContain('BSTACK_LOCAL_IDENTIFIER: "bstack-lite-integration-$(Build.BuildId)"');
        expect(job).toContain('LAB_TEST_PORT: "5179"');
        expect(job).not.toMatch(/dependsOn:|RUN_PARITY_TESTS|build:bundle|test:parity|test:perf/);
        const sanitize = job!.indexOf("redact-secrets.ts sanitize test-results/webgpu-integration-junit.xml");
        const verify = job!.indexOf("redact-secrets.ts verify test-results/webgpu-integration-junit.xml");
        const publish = job!.indexOf("PublishTestResults@2");
        expect(sanitize).toBeGreaterThanOrEqual(0);
        expect(verify).toBeGreaterThan(sanitize);
        expect(publish).toBeGreaterThan(verify);
        expect(job!.slice(verify, publish)).toContain("ArtifactsSafe]true");
        expect(job!.slice(publish)).toContain("condition: and(always(), eq(variables['ArtifactsSafe'], 'true'))");
        expect(job!.slice(publish)).toContain('testResultsFiles: "test-results/webgpu-integration-junit.xml"');
        expect(job!.slice(publish)).toContain("publishRunAttachments: false");
        const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
        expect(pkg.scripts["test:integration-cloud"]).toBe("playwright test --config config/playwright.integration-cloud.config.ts");
    });
});
