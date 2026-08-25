import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local (not checked in) for local overrides like SCREEN_X
const _envLocal = resolve(__dirname, ".env.local");
if (existsSync(_envLocal)) {
    for (const line of readFileSync(_envLocal, "utf-8").split("\n")) {
        const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) {
            process.env[m[1]] = m[2];
        }
    }
}

const screenX = process.env.SCREEN_X;
const headless = process.env.HEADLESS === "true";
const isCI = !!process.env.CI;

// Tests run their OWN isolated Vite dev server on a dedicated port — NOT the
// interactive lab (5174). Override with LAB_TEST_PORT if needed.
const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);

const swiftShaderArgs = isCI
    ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
    : [];

// GL perf sibling of playwright.perf.config.ts. The lite perf config pins its
// testDir to ./tests/lite/perf, so the GL perf suite needs its own config with
// testDir ./tests/gl/perf — otherwise a positional path filter would match no
// files inside the lite-only testDir. Everything else mirrors the lite config.
export default defineConfig({
    testDir: "./tests/gl/perf",
    timeout: 600_000,
    retries: 4,
    use: {
        channel: "chrome",
        headless,
        viewport: { width: 1280, height: 720 },
        launchOptions: {
            args: [
                "--force-color-profile=srgb",
                "--enable-precise-memory-info",
                "--enable-unsafe-webgpu",
                ...swiftShaderArgs,
                ...(screenX ? [`--window-position=${screenX},0`] : []),
            ],
        },
    },
    webServer: {
        command: "pnpm --filter @babylon-lite/lab dev",
        port: labTestPort,
        env: { LAB_DEV_PORT: String(labTestPort) },
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
