import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";

export const NATIVE_MACOS_WEBGPU_ARGS = [
    "--force-color-profile=srgb",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
    "--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist",
];

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            resolve();
        });
    });
    return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export default async function verifyNativeWebGpu(): Promise<void> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>WebGPU probe</title>");
    });
    const port = await listen(server);
    let browser: Browser | undefined;

    try {
        browser = await chromium.launch({
            channel: "chrome",
            headless: true,
            args: NATIVE_MACOS_WEBGPU_ARGS,
        });

        const cdp = await browser.newBrowserCDPSession();
        const systemInfo = await cdp.send("SystemInfo.getInfo");
        process.stdout.write(`[native-macos-webgpu] Chromium GPU devices ${JSON.stringify(systemInfo.gpu.devices)}\n`);
        const attributes = systemInfo.gpu.auxAttributes;
        process.stdout.write(
            `[native-macos-webgpu] Chromium GPU attributes ${JSON.stringify({
                displayType: attributes.displayType,
                glImplementationParts: attributes.glImplementationParts,
                glRenderer: attributes.glRenderer,
                glVendor: attributes.glVendor,
                sandboxed: attributes.sandboxed,
                skiaBackendType: attributes.skiaBackendType,
            })}\n`
        );

        const probePage = await browser.newPage();
        await probePage.goto(`http://127.0.0.1:${port}`);
        const probe = await probePage.evaluate(async () => {
            if (!navigator.gpu) {
                return { available: false, error: "navigator.gpu is undefined" };
            }

            const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
            if (!adapter) {
                return { available: false, error: "navigator.gpu.requestAdapter() returned null" };
            }

            const device = await adapter.requestDevice();
            device.destroy();
            const info = {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
            };
            return {
                available: true,
                fallback: adapter.isFallbackAdapter || /swiftshader|software/i.test(Object.values(info).join(" ")),
                info,
            };
        });

        process.stdout.write(`[native-macos-webgpu] adapter ${JSON.stringify(probe)}\n`);
        if (!probe.available) {
            throw new Error(`Native macOS Chrome cannot provide a WebGPU adapter: ${probe.error}`);
        }
        if (probe.fallback) {
            process.stderr.write("[native-macos-webgpu] WARNING: Chrome selected a fallback/software adapter; parity results will not represent Metal hardware.\n");
        }
    } finally {
        try {
            if (browser) {
                await browser.close();
            }
        } finally {
            await close(server);
        }
    }
}
