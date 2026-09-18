import {
    attachGaussianSplatStream,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    disposeEngine,
    disposeGaussianSplatStream,
    disposeScene,
    loadGaussianSplatStream,
    registerScene,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { ArcRotateCamera, GaussianSplatStream } from "babylon-lite";
import type {
    SplatLodCameraRecord,
    SplatLodComparisonOptions,
    SplatLodLeafRecord,
    SplatLodRunSummary,
    SplatLodSampleRecord,
    SplatLodWaypoint,
} from "../../../../scripts/splat-lod-comparison-types";
import { classifySplatLodOutcome, countSplatLodTargetDisplayGaps, waitForSplatLodDeadline } from "../../../../scripts/splat-lod-comparison-outcome";
import { transformStreamBound } from "../../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-selection";
import type { StreamLeafRuntime, StreamRepresentation } from "../../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";
import { placeTrogirStream } from "../demos/trogir-streaming-placement";
import { distanceToComparisonBound, intersectsComparisonFrustum } from "./splat-lod-comparison-geometry";

const FOV = 0.8;
const NEAR = 0.1;
const FAR = 1500;
const HEARTBEAT_MS = 2000;

function targetForWaypoint(waypoint: SplatLodWaypoint, overviewTarget: readonly [number, number, number]): readonly [number, number, number] {
    if (waypoint.target) {
        return waypoint.target;
    }
    if (!waypoint.eye) {
        return overviewTarget;
    }
    const yaw = ((waypoint.yawDegrees ?? 0) * Math.PI) / 180;
    const pitch = ((waypoint.pitchDegrees ?? 0) * Math.PI) / 180;
    const distance = 20;
    return [
        waypoint.eye[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
        waypoint.eye[1] + Math.sin(pitch) * distance,
        waypoint.eye[2] + Math.cos(yaw) * Math.cos(pitch) * distance,
    ];
}

function setCameraPose(camera: ArcRotateCamera, waypoint: SplatLodWaypoint, overviewTarget: readonly [number, number, number]): SplatLodCameraRecord {
    const target = targetForWaypoint(waypoint, overviewTarget);
    const eye: readonly [number, number, number] = waypoint.eye ?? [overviewTarget[0], overviewTarget[1] + Math.cos(1.16) * 260, overviewTarget[2] - Math.sin(1.16) * 260];
    const dx = eye[0] - target[0];
    const dy = eye[1] - target[1];
    const dz = eye[2] - target[2];
    camera.target.x = target[0];
    camera.target.y = target[1];
    camera.target.z = target[2];
    camera.radius = Math.hypot(dx, dy, dz);
    camera.alpha = Math.atan2(dz, dx);
    camera.beta = Math.acos(dy / camera.radius);
    camera.fov = FOV;
    camera.nearPlane = NEAR;
    camera.farPlane = FAR;
    return {
        requestedEye: eye,
        requestedTarget: target,
        actualWorldMatrix: [],
        fov: FOV,
        near: NEAR,
        far: FAR,
        viewport: [0, 0],
        dpr: 1,
    };
}

function representationLod(value: StreamRepresentation | null): number | null {
    return value?.lod ?? null;
}

function leafPaths(stream: GaussianSplatStream): string[] {
    const paths: string[] = [];
    const visit = (node: GaussianSplatStream["_manifest"]["root"], path: string): void => {
        if (node.kind === "leaf") {
            paths[node.id] = path;
            return;
        }
        node.children.forEach((child, index) => visit(child, `${path}/children/${index}`));
    };
    visit(stream._manifest.root, "tree");
    return paths;
}

function leafRecord(
    stream: GaussianSplatStream,
    paths: readonly string[],
    state: StreamLeafRuntime,
    eye: readonly [number, number, number],
    target: readonly [number, number, number],
    aspect: number
): SplatLodLeafRecord {
    const leaf = stream._manifest.leaves[state.target.leafId]!;
    const worldBound = transformStreamBound(leaf, stream.worldMatrix);
    const comparisonBound = {
        min: Array.from(worldBound.boundMin) as [number, number, number],
        max: Array.from(worldBound.boundMax) as [number, number, number],
    };
    const residentLods = leaf.alternatives.filter((value) => stream._sourceStates[value.fileId]!.state === "resident").map((value) => value.lod);
    const commonVisible = intersectsComparisonFrustum(comparisonBound, eye, target, FOV, aspect, NEAR, FAR);
    const displayed = leaf.alternatives.find((representation) =>
        stream._gpu.intervals.some(
            (interval) =>
                interval.source === stream._sourceStates[representation.fileId]!.gpu && interval.sourceOffset === representation.offset && interval.count === representation.count
        )
    );
    return {
        id: paths[leaf.id]!,
        index: leaf.id,
        visible: commonVisible,
        nativeVisible: state.visible,
        distance: distanceToComparisonBound(eye, comparisonBound),
        targetLod: commonVisible ? representationLod(state.target) : null,
        requestedLod: commonVisible ? representationLod(state.target) : null,
        displayedLod: commonVisible ? (displayed?.lod ?? null) : null,
        resolvedLods: commonVisible && displayed ? [displayed.lod] : [],
        targetCount: commonVisible ? state.target.count : null,
        displayedCount: commonVisible ? (displayed?.count ?? null) : null,
        targetSourceState: commonVisible ? stream._sourceStates[state.target.fileId]!.state : null,
        residentLods,
        gap: commonVisible && displayed ? displayed.lod - state.target.lod : commonVisible ? null : 0,
    };
}

function histogram(leaves: readonly SplatLodLeafRecord[], field: "targetLod" | "displayedLod"): Record<string, number> {
    const result: Record<string, number> = {};
    for (const leaf of leaves) {
        const value = leaf[field];
        if (leaf.visible && value !== null) {
            result[String(value)] = (result[String(value)] ?? 0) + 1;
        }
    }
    return result;
}

function distanceBins(leaves: readonly SplatLodLeafRecord[]): SplatLodRunSummary["waypoints"][number]["distanceBins"] {
    const bins = [
        ["0-1m", 0, 1],
        ["1-5m", 1, 5],
        ["5-15m", 5, 15],
        ["15m+", 15, Infinity],
    ] as const;
    return Object.fromEntries(
        bins.map(([name, min, max]) => {
            const members = leaves.filter((leaf) => leaf.distance >= min && leaf.distance < max);
            return [
                name,
                {
                    visibleLeaves: members.length,
                    targetDisplayGapLeaves: countSplatLodTargetDisplayGaps(members),
                    targetHistogram: histogram(members, "targetLod"),
                    displayedHistogram: histogram(members, "displayedLod"),
                },
            ];
        })
    );
}

function fingerprint(sample: SplatLodSampleRecord): string {
    return JSON.stringify([
        sample.phase,
        sample.queuedFiles,
        sample.pendingRequests,
        sample.selectedSplats,
        sample.activeSplats,
        sample.residentGpuBytes,
        sample.allocatedGpuBytes,
        sample.error,
        sample.leaves.map((leaf) => [leaf.index, leaf.visible, leaf.targetLod, leaf.displayedLod, leaf.targetSourceState, leaf.residentLods]),
    ]);
}

/** Runs the native Lite adapter in a real localhost page without exposing production instrumentation. */
export async function runLiteLodComparison(options: SplatLodComparisonOptions, emit: (record: SplatLodSampleRecord) => void | Promise<void>): Promise<SplatLodRunSummary> {
    const canvas = document.createElement("canvas");
    canvas.width = options.width * options.dpr;
    canvas.height = options.height * options.dpr;
    canvas.style.width = `${options.width}px`;
    canvas.style.height = `${options.height}px`;
    document.body.replaceChildren(canvas);
    const deadline = performance.now() + options.timeoutMs;
    let engine: Awaited<ReturnType<typeof createEngine>> | null = null;
    let scene: ReturnType<typeof createSceneContext> | null = null;
    let stream: GaussianSplatStream | null = null;
    let gpuErrorHandler: ((event: GPUUncapturedErrorEvent) => void) | null = null;
    const gpuErrors: string[] = [];
    const summaries: SplatLodRunSummary["waypoints"][number][] = [];
    try {
        const capacity = options.maxSplats + 10_000;
        engine = await waitForSplatLodDeadline(
            createEngine(canvas, {
                requiredLimits: {
                    maxBufferSize: capacity * 64,
                    maxStorageBufferBindingSize: capacity * 64,
                },
            }),
            deadline,
            "Babylon Lite engine initialization",
            disposeEngine
        );
        gpuErrorHandler = (event): void => {
            event.preventDefault();
            gpuErrors.push(event.error.message);
        };
        engine._device.addEventListener("uncapturederror", gpuErrorHandler);
        scene = createSceneContext(engine);
        stream = await waitForSplatLodDeadline(
            loadGaussianSplatStream(engine, options.assetUrl, {
                maxSplats: options.maxSplats,
                maxCapacitySplats: capacity,
                maxGpuBytes: options.maxGpuBytes,
                maxCpuBytes: options.maxCpuBytes,
                screenError: options.screenError,
            }),
            deadline,
            "Babylon Lite stream initialization",
            (lateStream) => {
                if (scene) {
                    disposeGaussianSplatStream(scene, lateStream);
                }
            }
        );
        const overview = placeTrogirStream(stream);
        const overviewTarget: readonly [number, number, number] = [overview.x, overview.y, overview.z];
        const camera = createArcRotateCamera(-Math.PI / 2, 1.16, 260, overview);
        scene.camera = camera;
        attachGaussianSplatStream(scene, stream);
        await waitForSplatLodDeadline(registerScene(scene), deadline, "Babylon Lite scene registration");
        await waitForSplatLodDeadline(startEngine(engine), deadline, "Babylon Lite engine start");
        await waitForSplatLodDeadline(stream.firstFrameReady, deadline, "Babylon Lite first frame");
        const paths = leafPaths(stream);
        const activeStream = stream;
        for (const waypoint of options.waypoints) {
            const sampleSequence = waypoint.name.includes("return") || waypoint.name.includes("repeat") ? "warm" : options.sequence;
            const requestedCamera = setCameraPose(camera, waypoint, overviewTarget);
            const requestedTarget = requestedCamera.requestedTarget;
            const startedAt = performance.now();
            let changedAt = startedAt;
            let emittedAt = -Infinity;
            let previousFingerprint = "";
            let final!: SplatLodSampleRecord;
            for (;;) {
                await new Promise<void>((resolve) => setTimeout(resolve, options.sampleMs));
                const now = performance.now();
                const actualEye: readonly [number, number, number] = [camera.worldMatrix[12]!, camera.worldMatrix[13]!, camera.worldMatrix[14]!];
                const leaves = activeStream._leafStates.map((state) => leafRecord(activeStream, paths, state, actualEye, requestedTarget, options.width / options.height));
                const gapLeaves = countSplatLodTargetDisplayGaps(leaves);
                const pressure = stream.stats.phase === "budget-limited";
                const error = gpuErrors[0] ?? stream.stats.error?.message ?? null;
                const cameraRecord: SplatLodCameraRecord = {
                    ...requestedCamera,
                    actualWorldMatrix: Array.from(camera.worldMatrix),
                    viewport: [options.width, options.height],
                    dpr: options.dpr,
                };
                const sample: SplatLodSampleRecord = {
                    type: "sample",
                    schemaVersion: 1,
                    engine: "babylon-lite",
                    engineVersion: "workspace",
                    sequence: sampleSequence,
                    profile: options.profile,
                    waypoint: waypoint.name,
                    elapsedMs: Math.round(now - startedAt),
                    phase: stream.stats.phase,
                    disposition: "sampling",
                    queuedFiles: stream.stats.queuedFiles,
                    pendingRequests: stream.stats.pendingRequests,
                    selectedSplats: stream.stats.selectedSplats,
                    activeSplats: stream._gpu.count,
                    residentGpuBytes: stream.stats.residentGpuBytes,
                    allocatedGpuBytes: stream.stats.allocatedGpuBytes,
                    pressure,
                    error,
                    camera: cameraRecord,
                    leaves,
                };
                const nextFingerprint = fingerprint(sample);
                const changed = nextFingerprint !== previousFingerprint;
                if (changed) {
                    previousFingerprint = nextFingerprint;
                    changedAt = now;
                }
                const quiet = now - changedAt >= options.quietMs;
                const timedOut = now - startedAt >= options.timeoutMs;
                const disposition = classifySplatLodOutcome({
                    timedOut,
                    quiet,
                    ready: stream.stats.phase === "idle",
                    pressure,
                    error,
                    queuedFiles: stream.stats.queuedFiles,
                    pendingRequests: stream.stats.pendingRequests,
                    gapLeaves,
                });
                final = { ...sample, disposition };
                if (changed || now - emittedAt >= HEARTBEAT_MS || disposition !== "sampling") {
                    await emit(final);
                    emittedAt = now;
                }
                if (disposition !== "sampling") {
                    break;
                }
            }
            if (final.disposition === "failed") {
                throw new Error(`Babylon Lite comparison failed at ${waypoint.name}: ${final.error}`);
            }
            const visible = final.leaves.filter((leaf) => leaf.visible);
            summaries.push({
                name: waypoint.name,
                disposition: final.disposition as Exclude<SplatLodSampleRecord["disposition"], "sampling">,
                elapsedMs: final.elapsedMs,
                visibleLeaves: visible.length,
                targetDisplayGapLeaves: countSplatLodTargetDisplayGaps(visible),
                nearest: [...visible].sort((left, right) => left.distance - right.distance || left.index - right.index).slice(0, 16),
                targetHistogram: histogram(visible, "targetLod"),
                displayedHistogram: histogram(visible, "displayedLod"),
                distanceBins: distanceBins(visible),
            });
        }
        return {
            engine: "babylon-lite",
            engineVersion: "workspace",
            sequence: options.sequence,
            profile: options.profile,
            assetUrl: options.assetUrl,
            settings: {
                codeRevision: options.codeRevision,
                workingTreeDirty: options.workingTreeDirty,
                assetUrl: options.assetUrl,
                width: options.width,
                height: options.height,
                dpr: options.dpr,
                maxSplats: options.maxSplats,
                maxGpuBytes: options.maxGpuBytes,
                maxCpuBytes: options.maxCpuBytes,
                screenError: options.screenError,
                sampleMs: options.sampleMs,
                quietMs: options.quietMs,
                timeoutMs: options.timeoutMs,
                sequence: options.sequence,
                profile: options.profile,
            },
            waypoints: summaries,
        };
    } finally {
        if (engine && gpuErrorHandler) {
            engine._device.removeEventListener("uncapturederror", gpuErrorHandler);
        }
        if (engine) {
            stopEngine(engine);
        }
        if (scene && stream) {
            disposeGaussianSplatStream(scene, stream);
        }
        if (scene) {
            disposeScene(scene);
        }
        if (engine) {
            disposeEngine(engine);
        }
    }
}
