import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test as base } from "@playwright/test";
import { installWebGpuRenderBundleObserver } from "./webgpu-render-bundle-observer.js";
import type { RenderBundleObservation } from "./webgpu-render-bundle-observer.js";

export interface SourceGeometry {
    readonly vertexCount: number;
    readonly indexCount: number;
    readonly minimum: readonly number[];
    readonly maximum: readonly number[];
    readonly selectedVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
    readonly selectedTriangles: ReadonlyArray<{
        readonly triangleOrdinal: number;
        readonly indices: readonly number[];
        readonly positions: readonly (readonly number[])[];
        readonly normals: readonly (readonly number[])[];
        readonly geometricNormal: readonly number[];
        readonly averagedNormal: readonly number[];
        readonly orientationDot: number;
        readonly tangentHandedness: readonly number[] | null;
    }>;
}

export interface SourceInstance {
    readonly key: string;
    readonly matrix: readonly number[];
    readonly origin: readonly number[];
    readonly basis: readonly (readonly number[])[];
    readonly determinant: number;
    readonly worldVertices: ReadonlyArray<{ readonly index: number; readonly position: readonly number[] }>;
}

export interface SourceFixture {
    readonly schemaVersion: number;
    readonly provenance: {
        readonly repository: string;
        readonly revision: string;
    };
    readonly comparisonSpace: {
        readonly absoluteTolerance: number;
        readonly relativeTolerance: number;
    };
    readonly assets: ReadonlyArray<{
        readonly model: string;
        readonly sourceMaterial: {
            readonly family: "nme" | "pbr";
            readonly doubleSided: boolean;
            readonly expectedCullMode: GPUCullMode;
            readonly expectedFrontFaceAfterBake: GPUFrontFace;
        };
        readonly comparisonGeometry: SourceGeometry;
    }>;
    readonly summary: {
        readonly placementCount: number;
        readonly batchCount: number;
        readonly instanceCount: number;
    };
    readonly placements: ReadonlyArray<{
        readonly key: string;
        readonly family: string;
        readonly batches: ReadonlyArray<{
            readonly key: string;
            readonly model: string;
            readonly instances: readonly SourceInstance[];
        }>;
    }>;
}

export interface LitePlacementSnapshot {
    readonly physics: "absent";
    readonly models: ReadonlyArray<{ readonly model: string } & SourceGeometry>;
    readonly placements: ReadonlyArray<{
        readonly key: string;
        readonly family: string;
        readonly batches: ReadonlyArray<{
            readonly key: string;
            readonly model: string;
            readonly matrices: readonly (readonly number[])[];
        }>;
    }>;
    readonly renderedBatchCount: number;
    readonly renderedInstanceCount: number;
}

export interface CubeStageMarkers {
    readonly schemaVersion: number;
    readonly sourceRevision: string;
    readonly model: "cube";
    readonly cohorts: ReadonlyArray<{
        readonly name: string;
        readonly batchKey: string;
        readonly instanceIndices: readonly number[];
        readonly task1Expectation: "matches-source-before-physics" | "fails-source-before-physics";
    }>;
    readonly checkpoints: ReadonlyArray<{
        readonly name: string;
        readonly owner: "task1" | "later-physics-task";
        readonly required: readonly string[];
    }>;
    readonly invariants: readonly string[];
}

export const sourceFixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests", "lite", "fixtures", "playroom-source-transforms.json"), "utf8")) as SourceFixture;
export const cubeStageMarkers = JSON.parse(readFileSync(resolve(process.cwd(), "tests", "lite", "fixtures", "playroom-cube-stage-markers.json"), "utf8")) as CubeStageMarkers;
const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);

async function readPlacementSnapshot(page: import("@playwright/test").Page): Promise<LitePlacementSnapshot> {
    const canvas = page.locator("#renderCanvas");
    await page.waitForFunction(() => {
        const element = document.getElementById("renderCanvas");
        return element?.dataset.ready === "true" || Boolean(element?.dataset.error);
    });
    const error = await canvas.getAttribute("data-error");
    expect(error).toBeNull();
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const text = await page.locator("#playroom-placement-snapshot").textContent();
    expect(text).not.toBeNull();
    return JSON.parse(text!) as LitePlacementSnapshot;
}

export const test = base.extend<{
    litePlacement: LitePlacementSnapshot;
    litePlacementBundles: { placement: LitePlacementSnapshot; observation: RenderBundleObservation };
}>({
    litePlacement: async ({ page }, use) => {
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.goto(`http://127.0.0.1:${labTestPort}/lite/playroom-placement-harness.html`);
        const placement = await readPlacementSnapshot(page);
        expect(
            requests.some((url) => /HavokPhysics\.wasm|@babylonjs(?:\/|%2F)havok/iu.test(url)),
            "physics-free harness loaded Havok"
        ).toBe(false);
        await use(placement);
    },
    litePlacementBundles: async ({ page }, use) => {
        const requests: string[] = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.addInitScript(installWebGpuRenderBundleObserver);
        await page.goto(`http://127.0.0.1:${labTestPort}/lite/playroom-placement-harness.html`);
        const placement = await readPlacementSnapshot(page);
        await page.waitForFunction(() => {
            const observation = window.__playroomRenderBundleObservation?.();
            return Boolean(observation?.executeBundlesCallCount && observation.executedBundles.some((bundle) => bundle.draws.length > 0));
        });
        const observation = await page.evaluate(() => window.__playroomRenderBundleObservation?.());
        expect(observation).toBeDefined();
        const placementOutput = process.env.PLAYROOM_PLACEMENT_SNAPSHOT_OUTPUT;
        if (placementOutput) {
            writeFileSync(placementOutput, `${JSON.stringify(placement, null, 2)}\n`);
        }
        const observationOutput = process.env.PLAYROOM_BUNDLE_OBSERVATION_OUTPUT;
        if (observationOutput) {
            writeFileSync(observationOutput, `${JSON.stringify(observation, null, 2)}\n`);
        }
        expect(
            requests.some((url) => /HavokPhysics\.wasm|@babylonjs(?:\/|%2F)havok/iu.test(url)),
            "physics-free harness loaded Havok"
        ).toBe(false);
        await use({ placement, observation: observation! });
    },
});

export { expect };

export interface LifecycleSnapshot {
    schemaVersion: number;
    sourceRevision: string;
    mode: string;
    phase: string;
    throwCount: number;
    frames: {
        rendered: number;
        wallMs: { count: number; median: number; p95: number; mean: number };
        javascriptMs: { count: number; median: number; p95: number; mean: number };
        gpuMs: { count: number; median: number; p95: number; mean: number };
        fixedPhysicsSteps: number;
    };
    contacts: {
        STARTED: number;
        CONTINUED: number;
        FINISHED: number;
        events: number;
        drains: number;
        nextCalls: number;
        activeAfterStepSubscribers: number;
        resolutions: {
            calls: number;
            successes: number;
            misses: number;
            thinLinearScans: number;
            elapsedMs: number;
        };
    };
    native: {
        bodies: { created: number; released: number; live: number };
        shapes: { created: number; released: number; live: number };
        constraints: { created: number; released: number; live: number };
        logicalRecords: number;
        activeInstances: number;
        transformPolls: number;
        linearVelocityReads: number;
        angularVelocityReads: number;
    };
    gpuWrites: {
        calls: number;
        sourceBytes: number;
        bufferCreates: number;
        bufferDestroys: number;
        pendingRetirements: number;
        retiringBatches: number;
        retiringCallbacks: number;
    };
    effects: {
        score: number;
        charge: number;
        confetti: number;
        descriptorRebuilds: number;
        popperEvents: number;
    };
    audio: {
        status: string;
        voices: number;
        pairTimes: number;
        profileTimes: number;
        poolIndices: number;
    };
    lifecycle: {
        retiredWorlds: number;
        retirementFrames: number[];
        timers: number;
        sceneMeshes: number;
        renderables: number;
        groupRenderables: number;
        nodeRenderables: number;
        nodeGroupRenderables: number;
        meshDisposerOwners: number;
        auxDisposerOwners: number;
    };
}

export interface RestartIdentity {
    world: number;
    records: number[];
    meshes: number[];
    bodies: number[];
    nativeBodies: number[];
    shapes: number[];
    constraints: number[];
    matrixArrays: number[];
    matrixBuffers: number[];
}

export interface RestartPlacement {
    matrixHashes: number[];
    gpuHashes: Array<number | null>;
    samples: Array<{ recordId: number; index: number; cpu: number[]; nativePosition: number[]; nativeRotation: number[] }>;
    visibleInstances: number;
    scoredEntries: number;
    hiddenPoppers: number;
    maxLinearVelocity: number;
    maxAngularVelocity: number;
}

export interface RestartCheckpoint {
    snapshot: LifecycleSnapshot;
    identity: RestartIdentity;
    placement: RestartPlacement;
    resources: {
        bodyCreates: number;
        bodyReleases: number;
        shapeCreates: number;
        shapeReleases: number;
        constraintCreates: number;
        constraintReleases: number;
        gpuBufferCreates: number;
        gpuBufferDestroys: number;
    };
}

export interface RestartWorkloadReport {
    baseline: RestartCheckpoint;
    disturbed: RestartCheckpoint;
    immediate: RestartCheckpoint;
    afterQueuedPop: RestartCheckpoint;
    afterFrames: RestartCheckpoint;
    secondExplosion: RestartCheckpoint;
    secondExplosionEvents: number;
    final: RestartCheckpoint;
    displacedIndices: number[];
    timings: { syncMs: number; recoveryMs: number; repeatedSyncMs: number[] };
}

export interface DisposeWorkloadReport {
    before: RestartCheckpoint;
    after: RestartCheckpoint;
    repeated: RestartCheckpoint;
}

export interface LifecycleWorkloadReport {
    schemaVersion: number;
    sourceRevision: string;
    mode: string;
    workload: {
        firstExplosions: number;
        remainingExplosions: number;
        maximumPopperEvents: number;
        completedThrows: number;
        replayCount: number;
    };
    stages: Array<{ name: string; snapshot: LifecycleSnapshot }>;
    final: LifecycleSnapshot;
}

export async function openLifecycleHarness(page: import("@playwright/test").Page, query = ""): Promise<void> {
    await page.goto(`http://127.0.0.1:${labTestPort}/lite/playroom-lifecycle-harness.html${query}`);
    await page.waitForFunction(
        () => {
            const canvas = document.getElementById("renderCanvas");
            return canvas?.dataset.ready === "true" || Boolean(canvas?.dataset.error);
        },
        undefined,
        { timeout: 60_000 }
    );
    expect(await page.locator("#renderCanvas").getAttribute("data-error")).toBeNull();
}

export async function lifecycleCommand<T>(page: import("@playwright/test").Page, action: "snapshot" | "wait" | "full" | "restart" | "dispose", frames?: number): Promise<T> {
    return page.evaluate(
        ({ commandAction, commandFrames }) =>
            new Promise<T>((resolve, reject) => {
                const id = `${Date.now()}-${Math.random()}`;
                const listener = (event: Event): void => {
                    const detail = (event as CustomEvent<{ id: string; result?: T; error?: string }>).detail;
                    if (detail.id !== id) {
                        return;
                    }
                    document.removeEventListener("playroom-lifecycle-response", listener);
                    if (detail.error) {
                        reject(new Error(detail.error));
                    } else {
                        resolve(detail.result!);
                    }
                };
                document.addEventListener("playroom-lifecycle-response", listener);
                document.dispatchEvent(new CustomEvent("playroom-lifecycle-command", { detail: { id, action: commandAction, frames: commandFrames } }));
            }),
        { commandAction: action, commandFrames: frames }
    );
}

export function lifecycleStage(report: LifecycleWorkloadReport, name: string): LifecycleSnapshot {
    const stage = report.stages.find((candidate) => candidate.name === name);
    expect(stage, `missing lifecycle stage ${name}`).toBeDefined();
    return stage!.snapshot;
}
