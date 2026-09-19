import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const outcomeModuleUrl = `/@fs/${resolve(__dirname, "../../../lab/lite/src/tools/splat-lod-comparison-outcome.ts").replaceAll("\\", "/")}`;
const liteAdapterModuleUrl = `/@fs/${resolve(__dirname, "../../../lab/lite/src/tools/splat-lod-comparison-lite.ts").replaceAll("\\", "/")}`;
const singleLeafManifest = {
    version: 1,
    lodLevels: 1,
    lodErrors: true,
    filenames: ["source/meta.json"],
    tree: {
        bound: { min: [-1, -1, -2], max: [1, 1, -1] },
        lods: { "0": { file: 0, offset: 0, count: 1 } },
        errors: [0],
    },
};

function liteOptions(assetUrl: string, timeoutMs: number) {
    return {
        assetUrl,
        codeRevision: "integration-test",
        workingTreeDirty: true,
        width: 64,
        height: 64,
        dpr: 1,
        maxSplats: 1,
        maxGpuBytes: 64 * 1024 * 1024,
        maxCpuBytes: 1024 * 1024,
        screenError: 2,
        sampleMs: 10,
        quietMs: 10,
        timeoutMs,
        sequence: "cold" as const,
        profile: "matched-budget" as const,
        waypoints: [{ name: "bootstrap", eye: [0, 0, 0] as const, target: [0, 0, -1] as const, fov: 0.8, near: 0.1, far: 100 }],
    };
}

test.beforeEach(async ({ page }) => {
    await page.goto("/lite/splat-lod-comparison.html");
});

test("turns an injected page error into one terminal failure and rejects later convergence", async ({ page }) => {
    const records: unknown[] = [];
    const outcome = await import("../../../lab/lite/src/tools/splat-lod-comparison-outcome");
    const gate = outcome.createSplatLodRuntimeFailureGate("lite", (record) => records.push(record));
    page.on("pageerror", (error) => gate.fail(`pageerror: ${error.message}`));
    await page.exposeFunction("__comparisonRecord", (record: unknown) => gate.accept(record as never));
    await page.evaluate(() => {
        const emit = (globalThis as typeof globalThis & { __comparisonRecord: (record: object) => Promise<void> }).__comparisonRecord;
        void emit({ type: "sample", disposition: "sampling", error: null });
        setTimeout(() => {
            throw new Error("injected after readiness");
        }, 0);
        setTimeout(() => void emit({ type: "sample", disposition: "converged", error: null }), 10);
    });
    await expect(gate.failure).rejects.toThrow("injected after readiness");
    await page.waitForTimeout(20);
    expect(records).toMatchObject([
        { disposition: "sampling", error: null },
        { disposition: "failed", error: expect.stringContaining("injected after readiness") },
    ]);
});

test("aborts a manifest body that stalls after response headers", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const outcome = await import(moduleUrl);
        const controller = new AbortController();
        const response = new Response(
            new ReadableStream({
                start(streamController) {
                    streamController.enqueue(new TextEncoder().encode("{"));
                },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
        );
        let message = "";
        try {
            await outcome.readSplatLodJsonResponse(response, performance.now() + 10, "manifest body", controller);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        return { message, aborted: controller.signal.aborted };
    }, outcomeModuleUrl);
    expect(result).toEqual({ message: "manifest body timed out", aborted: true });
});

test("writes an initialization failure for a page error before DOM readiness", async ({ page }) => {
    const outcome = await import("../../../lab/lite/src/tools/splat-lod-comparison-outcome");
    const records: Array<{ disposition: string; phase: string; error: string | null }> = [];
    const initialization = { type: "sample", disposition: "sampling", phase: "initializing", error: null } as never;
    const gate = outcome.createSplatLodRuntimeFailureGate("lite", (record) => records.push(record), initialization);
    page.on("pageerror", (error) => gate.fail(`pageerror: ${error.message}`));
    const lifecycle = outcome.settleSplatLodRuntimeLifecycle(
        page.goto("data:text/html,<script>throw new Error('before dom ready')</script>", { waitUntil: "domcontentloaded" }),
        async () => undefined,
        gate.failure
    );
    await expect(lifecycle).rejects.toThrow("before dom ready");
    expect(records).toMatchObject([{ disposition: "failed", phase: "initializing", error: expect.stringContaining("before dom ready") }]);
});

test("rejects a successful evaluation when a page error occurs during pending close", async ({ page }) => {
    const outcome = await import("../../../lab/lite/src/tools/splat-lod-comparison-outcome");
    const records: unknown[] = [];
    const gate = outcome.createSplatLodRuntimeFailureGate("lite", (record) => records.push(record), {
        type: "sample",
        disposition: "sampling",
        phase: "initializing",
        error: null,
    } as never);
    page.on("pageerror", (error) => gate.fail(`pageerror: ${error.message}`));
    const lifecycle = outcome.settleSplatLodRuntimeLifecycle(Promise.resolve({ ok: true }), () => new Promise<void>((resolveClose) => setTimeout(resolveClose, 30)), gate.failure);
    await page.evaluate(() =>
        setTimeout(() => {
            throw new Error("during close");
        }, 0)
    );
    await expect(lifecycle).rejects.toThrow("during close");
    expect(records).toMatchObject([{ disposition: "failed", phase: "initializing", error: expect.stringContaining("during close") }]);
});

test("surfaces an actual Lite bootstrap rejection through comparison records", async ({ page }) => {
    const assetUrl = new URL("/comparison-fixture/bootstrap-failure/lod-meta.json", page.url()).href;
    await page.route(assetUrl, (route) => route.fulfill({ json: singleLeafManifest }));
    await page.route(new URL("source/meta.json", assetUrl).href, (route) => route.fulfill({ status: 404, body: "missing" }));
    const result = await page.evaluate(
        async ({ moduleUrl, options }) => {
            const adapter = await import(moduleUrl);
            const records: Array<{ disposition: string; error: string | null }> = [];
            let message = "";
            try {
                await adapter.runLiteLodComparison(options, (record: { disposition: string; error: string | null }) => {
                    records.push(record);
                });
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            return { message, records };
        },
        { moduleUrl: liteAdapterModuleUrl, options: liteOptions(assetUrl, 2000) }
    );
    expect(result.message).toContain("comparison failed");
    expect(result.records.at(-1)).toMatchObject({ disposition: "failed", error: expect.stringContaining("HTTP 404") });
});

test("times out and disposes an actual Lite stream before readiness without a teardown rejection", async ({ page }) => {
    const assetUrl = new URL("/comparison-fixture/bootstrap-timeout/lod-meta.json", page.url()).href;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route(assetUrl, (route) => route.fulfill({ json: singleLeafManifest }));
    await page.route(new URL("source/meta.json", assetUrl).href, async (route) => {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3000));
        await route.fulfill({ status: 404, body: "late" }).catch(() => undefined);
    });
    const result = await page.evaluate(
        async ({ moduleUrl, options }) => {
            const adapter = await import(moduleUrl);
            const records: Array<{ disposition: string; error: string | null }> = [];
            const summary = await adapter.runLiteLodComparison(options, (record: { disposition: string; error: string | null }) => {
                records.push(record);
            });
            return { summary, records };
        },
        { moduleUrl: liteAdapterModuleUrl, options: liteOptions(assetUrl, 2000) }
    );
    expect(result.summary.waypoints[0]).toMatchObject({ disposition: "timeout" });
    expect(result.records.at(-1)).toMatchObject({ disposition: "timeout", error: null });
    await page.waitForTimeout(3050);
    expect(pageErrors).toEqual([]);
});

test("rejects a timeout when bootstrap fails during the terminal record callback", async ({ page }) => {
    const assetUrl = new URL("/comparison-fixture/bootstrap-terminal-race/lod-meta.json", page.url()).href;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route(assetUrl, (route) => route.fulfill({ json: singleLeafManifest }));
    await page.route(new URL("source/meta.json", assetUrl).href, async (route) => {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2100));
        await route.fulfill({ status: 404, body: "missing during terminal callback" });
    });
    const result = await page.evaluate(
        async ({ moduleUrl, options }) => {
            const adapter = await import(moduleUrl);
            const records: Array<{ disposition: string; error: string | null }> = [];
            let message = "";
            try {
                await adapter.runLiteLodComparison(options, async (record: { disposition: string; error: string | null }) => {
                    records.push(record);
                    if (record.disposition === "timeout") {
                        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
                    }
                });
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            return { message, records };
        },
        { moduleUrl: liteAdapterModuleUrl, options: liteOptions(assetUrl, 2000) }
    );
    expect(result.message).toContain("comparison failed");
    expect(result.records.at(-1)).toMatchObject({ disposition: "failed", error: expect.stringContaining("HTTP 404") });
    expect(pageErrors).toEqual([]);
});
