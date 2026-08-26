import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const port = 5191;
const packageDir = dirname(fileURLToPath(import.meta.url));
const isCI = process.env.CI === "true" || process.env.CI === "1";
const browserArgs = isCI
    ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
    : ["--use-gl=angle", "--use-angle=default", "--ignore-gpu-blocklist"];

export default defineConfig({
    testDir: "./tests/visual",
    testMatch: "visual.spec.ts",
    timeout: 30_000,
    workers: 1,
    expect: { timeout: 10_000 },
    snapshotPathTemplate: "{testDir}/reference/{arg}{ext}",
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        browserName: "chromium",
        channel: "chromium",
        headless: true,
        viewport: { width: 640, height: 480 },
        deviceScaleFactor: 1,
        colorScheme: "light",
        launchOptions: {
            args: browserArgs,
        },
    },
    webServer: {
        command: "node tests/visual/serve.mjs",
        cwd: packageDir,
        port,
        reuseExistingServer: false,
        timeout: 30_000,
        env: { LOTTIE_VISUAL_PORT: String(port) },
    },
});
