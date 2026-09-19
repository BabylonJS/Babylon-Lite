import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const DATASET_CONFIGURED = !!process.env.GS_STREAM_ASSET_ROOT;
const ACTUAL_MANIFEST_URL = process.env.GS_STREAM_TEST_URL ?? "/local-gs/trogir/lod-meta.json";
const ACTUAL_STREAM_CONFIGURED = DATASET_CONFIGURED || !!process.env.GS_STREAM_TEST_URL;
const sourceRoot = `/@fs/${resolve(__dirname, "../../../packages/babylon-lite/src").replaceAll("\\", "/")}`;
const placementUrl = `/@fs/${resolve(__dirname, "../../../lab/lite/src/demos/trogir-streaming-placement.ts").replaceAll("\\", "/")}`;

test.describe("Trogir streaming demo", () => {
    test.skip(!DATASET_CONFIGURED, "Set GS_STREAM_ASSET_ROOT to an authorized loose Trogir dataset.");

    test("serves the mount read-only without traversal", async ({ request }) => {
        const metadata = await request.get("/local-gs/trogir/lod-meta.json");
        expect(metadata.ok()).toBe(true);
        expect(metadata.headers()["content-type"]).toContain("application/json");

        const head = await request.head("/local-gs/trogir/6_0/meta.json");
        expect(head.ok()).toBe(true);
        expect(head.headers()["content-type"]).toContain("application/json");
        expect(await head.body()).toHaveLength(0);

        const image = await request.head("/local-gs/trogir/6_0/means_l.webp");
        expect(image.ok()).toBe(true);
        expect(image.headers()["content-type"]).toBe("image/webp");

        const write = await request.post("/local-gs/trogir/lod-meta.json");
        expect(write.status()).toBe(405);
        expect(write.headers().allow).toBe("GET, HEAD");

        const traversal = await request.get("/local-gs/trogir/%2e%2e%2Flicense.txt");
        expect(traversal.status()).toBe(400);
        expect(await traversal.text()).not.toContain(process.env.GS_STREAM_ASSET_ROOT!);
    });

    test("draws coarse data before visible refinement and disposes cleanly", async ({ page }) => {
        const errors: string[] = [];
        const requests: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") {
                errors.push(message.text());
            }
        });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
            if (request.url().includes("/local-gs/trogir/")) {
                requests.push(request.url());
            }
        });

        await page.goto("/demo-trogir-streaming.html?assetRoot=/local-gs/trogir/lod-meta.json");
        const canvas = page.locator("#renderCanvas");
        await expect(canvas).toHaveAttribute("data-coarse-ready", "true", { timeout: 60_000 });
        const coarseSubmittedAt = Number(await canvas.getAttribute("data-coarse-submitted-at"));
        const coarseReadyAt = Number(await canvas.getAttribute("data-coarse-ready-at"));
        expect(coarseSubmittedAt).toBeGreaterThan(0);
        expect(coarseReadyAt).toBeGreaterThanOrEqual(coarseSubmittedAt);

        await expect.poll(() => requests.some((url) => /\/[0-5]_\d+\/meta\.json$/.test(new URL(url).pathname)), { timeout: 60_000 }).toBe(true);
        const coarseMetadata = requests.findIndex((url) => url.endsWith("/6_0/meta.json"));
        let coarseLast = -1;
        requests.forEach((url, index) => {
            if (new URL(url).pathname.includes("/6_0/")) {
                coarseLast = index;
            }
        });
        const firstFine = requests.findIndex((url) => /\/[0-5]_\d+\/meta\.json$/.test(new URL(url).pathname));
        expect(coarseMetadata).toBeGreaterThan(0);
        expect(firstFine).toBeGreaterThan(coarseLast);

        await expect.poll(async () => Number(await canvas.getAttribute("data-resident-files")), { timeout: 60_000 }).toBeGreaterThan(1);
        expect(errors).toEqual([]);

        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        await expect(canvas).toHaveAttribute("data-disposed", "true");
        await expect(canvas).toHaveAttribute("data-stream-phase", "disposed");
    });
});

test.describe("Trogir actual stream", () => {
    test.skip(!ACTUAL_STREAM_CONFIGURED, "Set GS_STREAM_ASSET_ROOT or GS_STREAM_TEST_URL to an authorized loose Trogir dataset.");
    test("retains a valid default-budget scene through bounded settlement, navigation, resize, and behind-camera views", async ({ page }) => {
        test.setTimeout(120_000);
        await page.goto("/");
        const result = await page.evaluate(
            async ({ root, placementModule, manifestUrl }) => {
                const [engineModule, disposeModule, sceneModule, cameraModule, streamModule, placement] = await Promise.all([
                    import(`${root}/engine/engine.ts`),
                    import(`${root}/engine/engine-dispose.ts`),
                    import(`${root}/scene/scene.ts`),
                    import(`${root}/camera/arc-rotate.ts`),
                    import(`${root}/loader-splat-stream/load-gaussian-splat-stream.ts`),
                    import(placementModule),
                ]);
                let renderResources: readonly [GPUBuffer, GPUBuffer] | null = null;
                let indirectBuffer: GPUBuffer | null = null;
                let boundRenderResources: readonly [GPUBuffer, GPUBuffer] | null = null;
                const renderBindGroups = new WeakMap<GPUBindGroup, readonly [GPUBuffer, GPUBuffer]>();
                const originalCreateBindGroup = GPUDevice.prototype.createBindGroup;
                const originalSetBindGroup = GPURenderPassEncoder.prototype.setBindGroup;
                const originalDrawIndirect = GPURenderPassEncoder.prototype.drawIndirect;
                type SourceState = { source: { url: string }; state: string; gpu?: unknown };
                type GpuInterval = { source: unknown };
                type LeafState = { visible: boolean; target: { lod: number }; displayed: { lod: number } | null };
                type SetBindGroupArgs =
                    | [index: number, bindGroup: GPUBindGroup | null]
                    | [index: number, bindGroup: GPUBindGroup | null, dynamicOffsets: Iterable<number>]
                    | [index: number, bindGroup: GPUBindGroup | null, dynamicOffsetsData: Uint32Array, dynamicOffsetsDataStart: number, dynamicOffsetsDataLength: number];
                GPUDevice.prototype.createBindGroup = function (descriptor): GPUBindGroup {
                    const entries = Array.from(descriptor.entries);
                    const bindGroup = originalCreateBindGroup.call(this, descriptor);
                    const buffers = entries.map((entry) => ("buffer" in entry.resource ? entry.resource.buffer : null)).filter((buffer): buffer is GPUBuffer => buffer !== null);
                    if (entries.length === 2 && buffers.length === 2) {
                        renderBindGroups.set(bindGroup, [buffers[0]!, buffers[1]!]);
                    }
                    return bindGroup;
                };
                GPURenderPassEncoder.prototype.setBindGroup = function (this: GPURenderPassEncoder, ...args: SetBindGroupArgs): undefined {
                    const [index, bindGroup] = args;
                    if (index === 1) {
                        boundRenderResources = bindGroup ? (renderBindGroups.get(bindGroup) ?? null) : null;
                    }
                    (originalSetBindGroup as unknown as (this: GPURenderPassEncoder, ...originalArgs: SetBindGroupArgs) => undefined).apply(this, args);
                    return undefined;
                } as typeof originalSetBindGroup;
                GPURenderPassEncoder.prototype.drawIndirect = function (buffer, offset): undefined {
                    if (boundRenderResources) {
                        renderResources = boundRenderResources;
                        indirectBuffer = buffer;
                    }
                    originalDrawIndirect.call(this, buffer, offset);
                    return undefined;
                };

                const canvas = document.createElement("canvas");
                canvas.width = 640;
                canvas.height = 480;
                document.body.replaceChildren(canvas);
                const engine = await engineModule.createEngine(canvas);
                const scene = sceneModule.createSceneContext(engine);
                let stream: Awaited<ReturnType<typeof streamModule.loadGaussianSplatStream>> | null = null;
                const read = async (buffer: GPUBuffer, bytes: number): Promise<ArrayBuffer> => {
                    const output = engine._device.createBuffer({ size: Math.max(bytes, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    const encoder = engine._device.createCommandEncoder();
                    encoder.copyBufferToBuffer(buffer, 0, output, 0, Math.max(bytes, 4));
                    engine._device.queue.submit([encoder.finish()]);
                    await output.mapAsync(GPUMapMode.READ);
                    const copy = output.getMappedRange().slice(0);
                    output.unmap();
                    output.destroy();
                    return copy;
                };
                try {
                    stream = await streamModule.loadGaussianSplatStream(engine, new URL(manifestUrl, location.href).href, {
                        maxSplats: 1_000_000,
                        maxGpuBytes: 256 * 1024 * 1024,
                        maxCpuBytes: 96 * 1024 * 1024,
                        screenError: 2,
                    });
                    stream.maxSplats = 750_000;
                    const target = placement.placeTrogirStream(stream);
                    const camera = cameraModule.createArcRotateCamera(-Math.PI / 2, 1.16, 260, target);
                    camera.nearPlane = 0.1;
                    camera.farPlane = 1500;
                    scene.camera = camera;
                    streamModule.attachGaussianSplatStream(scene, stream);
                    await sceneModule.registerScene(scene);
                    await engineModule.startEngine(engine);
                    await stream.firstFrameReady;

                    const environment = stream._sourceStates.find((state: SourceState) => state.source.url.endsWith("/env/meta.json"));
                    if (!environment) {
                        throw new Error("Trogir environment source was not registered");
                    }
                    const deadline = performance.now() + 60_000;
                    while (environment.state !== "resident" && performance.now() < deadline) {
                        await new Promise(requestAnimationFrame);
                    }
                    if (environment.state !== "resident") {
                        throw new Error(`Trogir environment did not become resident: ${environment.state}`);
                    }
                    let stableSettlementFrames = 0;
                    let blockedFingerprint = "";
                    const settlementDeadline = performance.now() + 60_000;
                    while (stableSettlementFrames < 5 && performance.now() < settlementDeadline) {
                        await new Promise(requestAnimationFrame);
                        const nextFingerprint = stream._sourceStates
                            .filter((state: SourceState & { generation: number }) => state.state === "blocked")
                            .map((state: SourceState & { generation: number }) => `${state.source.url}:${state.generation}`)
                            .join("|");
                        const stable =
                            (stream.stats.phase === "idle" || stream.stats.phase === "budget-limited") &&
                            stream.stats.queuedFiles === 0 &&
                            stream.stats.pendingRequests === 0 &&
                            nextFingerprint === blockedFingerprint;
                        stableSettlementFrames = stable ? stableSettlementFrames + 1 : 0;
                        blockedFingerprint = nextFingerprint;
                    }
                    if (stableSettlementFrames < 5) {
                        throw new Error(`Trogir stream did not settle within its budget: ${stream.stats.phase}`);
                    }
                    const canonicalContains = (representation: { fileId: number; offset: number; count: number } | null): boolean =>
                        !!representation &&
                        stream._gpu.intervals.some(
                            (interval: { source: unknown; sourceOffset: number; count: number }) =>
                                interval.source === stream!._sourceStates[representation.fileId]!.gpu &&
                                interval.sourceOffset === representation.offset &&
                                interval.count === representation.count
                        );
                    const visibleLeaves = stream._leafStates.filter((leaf: LeafState) => leaf.visible);
                    const settlement = {
                        phase: stream.stats.phase,
                        error: stream.stats.error?.message,
                        blockedFingerprint,
                        generationPressure: stream._generationPressure,
                        targetCanonicalGaps: visibleLeaves.filter((leaf: LeafState) => !canonicalContains(leaf.target as never)).length,
                        displayedCanonicalGaps: visibleLeaves.filter((leaf: LeafState) => !canonicalContains(leaf.displayed as never)).length,
                        pendingLeaves: visibleLeaves.filter((leaf: LeafState & { pending: unknown }) => leaf.pending).length,
                        allocated: stream._gpu.ledger.allocatedBytes,
                        held: stream._gpu.ledger.heldBytes,
                        max: stream._gpu.ledger.maxBytes,
                    };

                    const eye = [15.8, 1.68, -70.5];
                    const yaw = (75.83 * Math.PI) / 180;
                    const pitch = (-10.43 * Math.PI) / 180;
                    const radius = 20;
                    const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
                    camera.target.x = eye[0]! + forward[0]! * radius;
                    camera.target.y = eye[1]! + forward[1]! * radius;
                    camera.target.z = eye[2]! + forward[2]! * radius;
                    camera.alpha = Math.atan2(eye[2]! - camera.target.z, eye[0]! - camera.target.x);
                    camera.beta = Math.acos((eye[1]! - camera.target.y) / radius);
                    camera.radius = radius;
                    let navigationStableFrames = 0;
                    let navigationAllocated = -1;
                    const navigationDeadline = performance.now() + 60_000;
                    while (navigationStableFrames < 5 && performance.now() < navigationDeadline) {
                        await new Promise(requestAnimationFrame);
                        const allocated = stream._gpu.ledger.allocatedBytes;
                        const stable = stream.stats.queuedFiles === 0 && stream.stats.pendingRequests === 0 && allocated === navigationAllocated;
                        navigationStableFrames = stable ? navigationStableFrames + 1 : 0;
                        navigationAllocated = allocated;
                    }
                    if (navigationStableFrames < 5) {
                        throw new Error("Trogir navigation did not settle");
                    }
                    if (stream.stats.error) {
                        throw stream.stats.error;
                    }
                    const nearbyLods = {
                        targetZero: stream._leafStates.filter((leaf: LeafState) => leaf.visible && leaf.target.lod === 0).length,
                        displayedZero: stream._leafStates.filter((leaf: LeafState) => leaf.visible && leaf.displayed?.lod === 0).length,
                        failedSources: stream._sourceStates.filter((source: SourceState) => source.state === "failed").length,
                    };
                    engineModule.stopEngine(engine);
                    await engine._device.queue.onSubmittedWorkDone();

                    const inspect = async (): Promise<{
                        active: number;
                        instances: number;
                        invalidPrefix: number;
                        duplicates: number;
                        unsorted: number;
                        nonfiniteProjected: number;
                        maxPixelAxis: number;
                    }> => {
                        engineModule.renderFrame(engine, 16);
                        await engine._device.queue.onSubmittedWorkDone();
                        const resources = renderResources;
                        const indirectSource = indirectBuffer;
                        if (!resources || !indirectSource) {
                            throw new Error("Streaming draw resources were not observed");
                        }
                        const indirect = new Uint32Array(await read(indirectSource, 16));
                        const active = stream!._gpu.count;
                        const keys = new Uint32Array(await read(resources[1], active * 8));
                        const projected = new Float32Array(await read(resources[0], active * 64));
                        const seen = new Uint8Array(active);
                        let invalidPrefix = 0;
                        let duplicates = 0;
                        let unsorted = 0;
                        let nonfiniteProjected = 0;
                        let maxPixelAxis = 0;
                        for (let draw = 0; draw < indirect[1]!; draw++) {
                            const key = keys[draw * 2]!;
                            const index = keys[draw * 2 + 1]!;
                            if (key === 0xffffffff || index >= active) {
                                invalidPrefix++;
                                continue;
                            }
                            if (draw > 0 && key < keys[(draw - 1) * 2]!) {
                                unsorted++;
                            }
                            if (seen[index]) {
                                duplicates++;
                            }
                            seen[index] = 1;
                            const base = index * 16;
                            const record = projected.subarray(base, base + 16);
                            if (!record.every(Number.isFinite) || !(record[3]! > 0)) {
                                nonfiniteProjected++;
                                continue;
                            }
                            maxPixelAxis = Math.max(
                                maxPixelAxis,
                                Math.hypot((record[4]! / record[3]!) * canvas.width, (record[5]! / record[3]!) * canvas.height),
                                Math.hypot((record[8]! / record[3]!) * canvas.width, (record[9]! / record[3]!) * canvas.height)
                            );
                        }
                        return { active, instances: indirect[1]!, invalidPrefix, duplicates, unsorted, nonfiniteProjected, maxPixelAxis };
                    };

                    const nearby = await inspect();
                    const allocatedBeforeResize = stream._gpu.ledger.allocatedBytes;
                    engineModule.setEngineSize(engine, 600, 400);
                    const resized = await inspect();
                    const allocatedAfterResize = stream._gpu.ledger.allocatedBytes;
                    camera.target.x = 0;
                    camera.target.y = 0;
                    camera.target.z = 5260;
                    camera.alpha = -Math.PI / 2;
                    camera.beta = Math.PI / 2;
                    camera.radius = 260;
                    const behind = [await inspect(), await inspect(), await inspect()];

                    camera.target.x = 16.26208240914299;
                    camera.target.y = 1.3343776463831427;
                    camera.target.z = -43.83520731996345;
                    const streetEye = [14.774544715881348, 1.5231726169586182, -42.5117301940918];
                    const dx = streetEye[0]! - camera.target.x;
                    const dy = streetEye[1]! - camera.target.y;
                    const dz = streetEye[2]! - camera.target.z;
                    camera.radius = Math.hypot(dx, dy, dz);
                    camera.alpha = Math.atan2(dz, dx);
                    camera.beta = Math.acos(dy / camera.radius);
                    const street = await inspect();
                    const environmentActive = stream._gpu.intervals.some(
                        (interval: GpuInterval) => stream!._sourceStates.find((state: SourceState) => state.gpu === interval.source)?.source.url === environment.source.url
                    );
                    return {
                        settlement,
                        nearbyLods,
                        nearby,
                        resized,
                        allocatedBeforeResize,
                        allocatedAfterResize,
                        behind,
                        street,
                        environmentActive,
                        finalError: stream.stats.error?.message,
                    };
                } finally {
                    GPUDevice.prototype.createBindGroup = originalCreateBindGroup;
                    GPURenderPassEncoder.prototype.setBindGroup = originalSetBindGroup;
                    GPURenderPassEncoder.prototype.drawIndirect = originalDrawIndirect;
                    engineModule.stopEngine(engine);
                    if (stream) {
                        streamModule.disposeGaussianSplatStream(scene, stream);
                    }
                    sceneModule.disposeScene(scene);
                    disposeModule.disposeEngine(engine);
                }
            },
            { root: sourceRoot, placementModule: placementUrl, manifestUrl: ACTUAL_MANIFEST_URL }
        );

        expect(result.environmentActive).toBe(true);
        expect(["idle", "budget-limited"]).toContain(result.settlement.phase);
        expect(result.settlement).toMatchObject({ error: undefined, targetCanonicalGaps: 0, displayedCanonicalGaps: 0, pendingLeaves: 0 });
        expect(result.settlement.allocated + result.settlement.held).toBeLessThanOrEqual(result.settlement.max);
        if (result.settlement.phase === "budget-limited") {
            expect(result.settlement.generationPressure || result.settlement.blockedFingerprint !== "").toBe(true);
        }
        expect(result.finalError).toBeUndefined();
        expect(result.nearbyLods.targetZero).toBeGreaterThan(0);
        expect(result.nearbyLods.displayedZero).toBeGreaterThan(0);
        expect(result.nearbyLods.failedSources).toBe(0);
        expect(result.nearby.instances).toBeGreaterThan(0);
        expect([result.nearby.nonfiniteProjected, result.nearby.maxPixelAxis <= 1024.01]).toEqual([0, true]);
        expect(result.resized.instances).toBeGreaterThan(0);
        expect(result.allocatedAfterResize).toBe(result.allocatedBeforeResize);
        expect(result.behind.every((frame) => frame.active > 0 && frame.instances === 0)).toBe(true);
        expect(result.street.instances).toBeGreaterThan(0);
        expect([result.street.invalidPrefix, result.street.duplicates, result.street.unsorted, result.street.nonfiniteProjected, result.street.maxPixelAxis <= 1024.01]).toEqual([
            0,
            0,
            0,
            0,
            true,
        ]);
    });
});
