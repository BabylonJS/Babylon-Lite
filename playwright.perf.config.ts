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

const swiftShaderArgs = isCI
    ? ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"]
    : [];

export default defineConfig({
    testDir: "./tests/perf",
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
        command: "pnpm --filter lab dev",
        port: 5174,
        reuseExistingServer: true,
        timeout: 15_000,
    },
});
