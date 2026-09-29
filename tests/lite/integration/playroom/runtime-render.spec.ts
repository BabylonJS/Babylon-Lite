import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type * as BabylonLite from "../../../../packages/babylon-lite/src/index.js";
import {
    installTemporalPlayroomRoute,
    matrixPosition,
    prepareFreeModeTarget,
    readTemporalPose,
    waitForTargetMovement,
    waitForTemporalPlayroom,
    type TemporalPose,
    type TemporalTarget,
} from "./runtime-physics-gpu.js";
import { installWebGpuRenderBundleObserver } from "./webgpu-render-bundle-observer.js";
import type { ObservedBuffer, ObservedBundleDraw } from "./webgpu-render-bundle-observer.js";

const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);

test("preserves original ground lighting and darkens only shadows with a nonphysical receiver", async ({ page }) => {
    await installTemporalPlayroomRoute(page);
    await waitForTemporalPlayroom(page, labTestPort);
    const settings = await page.evaluate(
        async (moduleUrl) => {
            const lite = (await import(moduleUrl)) as typeof BabylonLite;
            const state = window.__playroomTemporalState!;
            const ground = state.world.meshes.find((mesh) => mesh.name === "playroom-ground")!;
            const receiver = lite.getContainerMeshes({ entities: [ground] }).find((mesh) => mesh.name === "playroom-ground-shadows")!;
            if (!receiver || !lite.isPbrMaterial(receiver.material)) {
                throw new Error("The ground is missing its PBR shadow-only receiver.");
            }
            return {
                exposure: state.scene.imageProcessing.exposure,
                contrast: state.scene.imageProcessing.contrast,
                lightIntensities: state.scene.lights.map((light) => {
                    if (!("intensity" in light)) {
                        throw new Error(`Unexpected Playroom light type: ${light.lightType}`);
                    }
                    return light.intensity;
                }),
                sourceRugMaterial: ground.material === state.assets.rugMaterial,
                shadow: lite.getShadowOnly(receiver.material),
                heightAboveGround: receiver.worldMatrix[13]! - ground.worldMatrix[13]!,
                receivesShadows: receiver.receiveShadows,
                pickable: receiver.pickable,
                parentedToGround: receiver.parent === ground,
                inCasterInventory: state.world.meshes.includes(receiver),
                hasPhysicsBody: state.world.records.some((record) => record.mesh === receiver),
            };
        },
        `/@fs/${resolve("packages/babylon-lite/src/index.ts").replaceAll("\\", "/")}`
    );
    expect(settings).toMatchObject({
        exposure: 1,
        contrast: 1,
        lightIntensities: [0.85, 0.1],
        sourceRugMaterial: true,
        shadow: { color: [0, 0, 0], opacity: 0.65 },
        receivesShadows: true,
        pickable: false,
        parentedToGround: true,
        inCasterInventory: false,
        hasPhysicsBody: false,
    });
    expect(settings.heightAboveGround).toBeCloseTo(0.001, 6);
});

function expectPositionsToMatch(actual: readonly number[], expected: readonly number[]): void {
    expect(actual[0]).toBeCloseTo(expected[0]!, 3);
    expect(actual[1]).toBeCloseTo(expected[1]!, 3);
    expect(actual[2]).toBeCloseTo(expected[2]!, 3);
}

function expectTemporalSync(before: TemporalPose, after: TemporalPose): void {
    expectPositionsToMatch(matrixPosition(after.nativeMatrix), matrixPosition(after.cpuMatrix));
    expectPositionsToMatch(matrixPosition(after.gpuMatrix), matrixPosition(after.cpuMatrix));
    expect(after.thinVersion).toBe(after.gpuVersion);
    expect(after.bufferId).toBe(before.bufferId);
    expect(after.bundles.main.id).toBe(before.bundles.main.id);
    expect(after.bundles.shadow.id).toBe(before.bundles.shadow.id);
    expect(after.bundles.main.executionCount).toBeGreaterThan(before.bundles.main.executionCount);
    expect(after.bundles.shadow.executionCount).toBeGreaterThan(before.bundles.shadow.executionCount);
    expect(after.finishCount).toBe(before.finishCount);
}

function cubeGpuOrientation(draw: ObservedBundleDraw, buffers: ReadonlyMap<number, ObservedBuffer>): number {
    const indexBinding = draw.indexBuffer!;
    const indexBytes = Buffer.from(buffers.get(indexBinding.bufferId)!.dataBase64, "base64");
    const indexOffset = indexBytes.byteOffset + indexBinding.offset;
    const indices =
        indexBinding.format === "uint16"
            ? new Uint16Array(indexBytes.buffer, indexOffset, indexBytes.byteLength / Uint16Array.BYTES_PER_ELEMENT)
            : new Uint32Array(indexBytes.buffer, indexOffset, indexBytes.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    const vertexBuffer = (slot: number) => {
        const binding = draw.vertexBuffers.find((entry) => entry.slot === slot)!;
        const bytes = Buffer.from(buffers.get(binding.bufferId)!.dataBase64, "base64");
        return new Float32Array(bytes.buffer, bytes.byteOffset + binding.offset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
    };
    const positions = vertexBuffer(0);
    const normals = vertexBuffer(1);
    const triangle = Array.from(indices.slice(draw.firstIndex, draw.firstIndex + 3), (index) => index + draw.baseVertex);
    const point = (index: number) => positions.slice(index * 3, index * 3 + 3);
    const normal = (index: number) => normals.slice(index * 3, index * 3 + 3);
    const [a, b, c] = triangle.map(point);
    const ab = b!.map((value, axis) => value - a![axis]!);
    const ac = c!.map((value, axis) => value - a![axis]!);
    const geometric = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    const averaged = triangle.map(normal).reduce((sum, value) => sum.map((entry, axis) => entry + value[axis]!), [0, 0, 0]);
    return geometric.reduce((sum, value, axis) => sum + value * averaged[axis]!, 0);
}

test("keeps full-runtime Playroom instances front-facing in matching main and shadow bundles", async ({ page }) => {
    await page.addInitScript(installWebGpuRenderBundleObserver);
    await page.goto(`http://127.0.0.1:${labTestPort}/lite/demo-playroom.html`);
    await page.waitForFunction(
        () => {
            const canvas = document.getElementById("renderCanvas");
            const observation = window.__playroomRenderBundleObservation?.();
            return (
                canvas?.dataset.ready === "true" &&
                observation?.executedBundles.some((bundle) => bundle.descriptor.colorFormats.length === 0 && bundle.draws.length >= 135) &&
                observation.executedBundles.some((bundle) => bundle.descriptor.colorFormats.length > 0 && bundle.draws.length >= 135)
            );
        },
        undefined,
        { timeout: 60_000 }
    );
    const error = await page.locator("#renderCanvas").getAttribute("data-error");
    expect(error).toBeNull();
    const observation = await page.evaluate(() => window.__playroomRenderBundleObservation?.());
    expect(observation).toBeDefined();

    const output = process.env.PLAYROOM_RUNTIME_BUNDLE_OUTPUT;
    if (output) {
        writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
    }
    const pipelines = new Map(observation!.pipelines.map((pipeline) => [pipeline.id, pipeline]));
    const buffers = new Map(observation!.buffers.map((buffer) => [buffer.id, buffer]));
    const selectLargest = (shadow: boolean) =>
        observation!.executedBundles.filter((bundle) => (bundle.descriptor.colorFormats.length === 0) === shadow).sort((left, right) => right.draws.length - left.draws.length)[0]!;
    const thinDraws = (shadow: boolean) =>
        selectLargest(shadow).draws.filter((draw) => draw.vertexBuffers.some((binding) => buffers.get(binding.bufferId)?.label === "thin-instance-matrices"));
    const main = thinDraws(false);
    const shadow = thinDraws(true);
    expect(main.length).toBeGreaterThanOrEqual(135);
    expect(shadow.length).toBeGreaterThanOrEqual(135);
    const shadowCounts = shadow.map((draw) => draw.instanceCount);
    const commonCounts = main
        .map((draw) => draw.instanceCount)
        .filter((count) => {
            const index = shadowCounts.indexOf(count);
            if (index < 0) return false;
            shadowCounts.splice(index, 1);
            return true;
        });
    expect(commonCounts.length, "main/shadow instance cohorts").toBeGreaterThanOrEqual(135);
    expect(commonCounts.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(1955);

    for (const [pass, draws] of [
        ["main", main],
        ["shadow", shadow],
    ] as const) {
        const usedPipelines = draws.map((draw) => pipelines.get(draw.pipelineId!)).filter((pipeline) => pipeline !== undefined);
        expect(usedPipelines, `${pass} pipelines`).toHaveLength(draws.length);
        expect(
            usedPipelines.some((pipeline) => pipeline.label === (pass === "main" ? "node-material" : "node-material-depth")),
            `${pass} NME pipeline`
        ).toBe(true);
        expect(
            usedPipelines.some((pipeline) => pipeline.label === ""),
            `${pass} PBR pipeline`
        ).toBe(true);
        for (const pipeline of usedPipelines) {
            expect(pipeline.primitive.frontFace, `${pass} frontFace`).toBe("ccw");
            expect(["back", "none"], `${pass} cullMode`).toContain(pipeline.primitive.cullMode);
        }

        // cubeBlock.glb is the only PBR Playroom model with 324 indices; the other
        // 324-index models use the node-material pipeline. Its authored material is
        // double-sided, so color replacement must retain that native GPU contract.
        const cubeDraws = draws.filter((draw) => draw.indexCount === 324 && pipelines.get(draw.pipelineId!)?.label === "");
        expect(cubeDraws, `${pass} cube batches`).toHaveLength(45);
        for (const draw of cubeDraws) {
            expect(pipelines.get(draw.pipelineId!)!.primitive.cullMode, `${pass} cube cullMode`).toBe("back");
        }
        if (pass === "main") {
            expect(cubeGpuOrientation(cubeDraws[0]!, buffers), "cube GPU winding follows Babylon Lite's visible-face convention").toBeLessThan(0);
        }
    }
});

test("keeps cached main and shadow bundle matrices synchronized during short Free Mode clicks", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(installWebGpuRenderBundleObserver);
    await installTemporalPlayroomRoute(page);

    const clickTarget = async (bodyName: string, index: number): Promise<[TemporalTarget, TemporalPose, TemporalPose]> => {
        await waitForTemporalPlayroom(page, labTestPort);
        await page.getByRole("button", { name: "Play" }).click();
        await page.getByRole("button", { name: "Free Mode" }).click();
        await page.waitForFunction(() => window.__playroomTemporalState?.phase === "free");
        const target = await prepareFreeModeTarget(page, bodyName, index);
        const before = await readTemporalPose(page, target);
        await page.mouse.move(target.screen![0], target.screen![1]);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        await waitForTargetMovement(page, target, matrixPosition(before.nativeMatrix), 0.01);
        return [target, before, await readTemporalPose(page, target)];
    };

    const [, pbrBefore, pbrAfter] = await clickTarget("cubeStack-32", 0);
    expectTemporalSync(pbrBefore, pbrAfter);

    const [, nodeBefore, nodeAfter] = await clickTarget("domino-6", 1);
    expectTemporalSync(nodeBefore, nodeAfter);
});
