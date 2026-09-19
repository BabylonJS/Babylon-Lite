import { distanceToComparisonBound, intersectsComparisonFrustum, transformTrogirManifestBound } from "./splat-lod-comparison-geometry.ts";
import { classifySplatLodOutcome, countSplatLodTargetDisplayGaps, readSplatLodJsonResponse, waitForSplatLodDeadline } from "./splat-lod-comparison-outcome.ts";

const PLAYCANVAS_URL = "https://cdn.jsdelivr.net/npm/playcanvas@2.22.1/build/playcanvas.mjs";
const EXPECTED_VERSION = "2.22.1";
const EXPECTED_REVISION = "73787b3";
const FOV = 0.8;
const NEAR = 0.1;
const FAR = 1500;
const HEARTBEAT_MS = 2000;

function targetForWaypoint(waypoint, overviewTarget) {
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

function overviewTarget(manifest) {
    const min = manifest.tree.bound.min;
    const max = manifest.tree.bound.max;
    return [-(min[0] + max[0]) * 0.5, -(min[1] + max[1]) * 0.5, -(min[2] + max[2]) * 0.5];
}

function requestedPose(waypoint, center) {
    const target = targetForWaypoint(waypoint, center);
    const eye = waypoint.eye ?? [center[0], center[1] + Math.cos(1.16) * 260, center[2] - Math.sin(1.16) * 260];
    return { eye, target, forward: [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]] };
}

function collectLeaves(node, path, output) {
    if (node.lods) {
        output.push({ path, raw: node });
        return;
    }
    node.children?.forEach((child, index) => collectLeaves(child, `${path}/children/${index}`, output));
}

function histogram(leaves, field) {
    const result = {};
    for (const leaf of leaves) {
        const value = leaf[field];
        if (leaf.visible && value !== null) {
            result[String(value)] = (result[String(value)] ?? 0) + 1;
        }
    }
    return result;
}

function distanceBins(leaves) {
    return Object.fromEntries(
        [
            ["0-1m", 0, 1],
            ["1-5m", 1, 5],
            ["5-15m", 5, 15],
            ["15m+", 15, Infinity],
        ].map(([name, min, max]) => {
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

function fingerprint(sample) {
    return JSON.stringify([
        sample.phase,
        sample.queuedFiles,
        sample.pendingRequests,
        sample.selectedSplats,
        sample.activeSplats,
        sample.residentGpuBytes,
        sample.error,
        sample.leaves.map((leaf) => [leaf.index, leaf.visible, leaf.targetLod, leaf.requestedLod, leaf.displayedLod, leaf.targetSourceState, leaf.residentLods]),
    ]);
}

function sourceUrl(manifestUrl, manifest, fileIndex) {
    return new URL(manifest.filenames[fileIndex], manifestUrl).href;
}

function sourceState(octree, loader, url, fileIndex) {
    if (octree.fileResources.has(fileIndex)) {
        return "resident";
    }
    if ([...loader._failed].some((value) => String(value) === url)) {
        return "failed";
    }
    if ([...loader._currentlyLoading].some((value) => String(value) === url)) {
        return "loading";
    }
    if ([...loader._loadQueue].some((value) => String(value) === url)) {
        return "queued";
    }
    return "unrequested";
}

async function createReference(options, deadline, initialWaypoint) {
    let app = null;
    let device = null;
    try {
        const pc = await waitForSplatLodDeadline(import(/* @vite-ignore */ PLAYCANVAS_URL), deadline, "PlayCanvas module initialization");
        if (pc.version !== EXPECTED_VERSION || !pc.revision.startsWith(EXPECTED_REVISION)) {
            throw new Error(`Unexpected PlayCanvas reference ${pc.version}/${pc.revision}`);
        }
        if (!navigator.gpu) {
            throw new Error("PlayCanvas comparison requires WebGPU");
        }
        const manifestController = new AbortController();
        const response = await waitForSplatLodDeadline(fetch(options.assetUrl, { signal: manifestController.signal }), deadline, "PlayCanvas manifest request", undefined, () =>
            manifestController.abort()
        );
        if (!response.ok) {
            throw new Error(`PlayCanvas manifest HTTP ${response.status}`);
        }
        const manifest = await readSplatLodJsonResponse(response, deadline, "PlayCanvas manifest body", manifestController);
        const rawLeaves = [];
        collectLeaves(manifest.tree, "tree", rawLeaves);
        const canvas = document.createElement("canvas");
        canvas.width = options.width * options.dpr;
        canvas.height = options.height * options.dpr;
        canvas.style.width = `${options.width}px`;
        canvas.style.height = `${options.height}px`;
        document.body.replaceChildren(canvas);
        device = new pc.WebgpuGraphicsDevice(canvas, {
            antialias: false,
            alpha: false,
            depth: true,
            stencil: false,
            powerPreference: "high-performance",
            xrCompatible: false,
        });
        await waitForSplatLodDeadline(device.initWebGpu(), deadline, "PlayCanvas WebGPU initialization");
        app = new pc.Application(canvas, { graphicsDevice: device });
        app.scene.gsplatCentersEnabled = false;
        const params = app.scene.gsplat;
        params.renderer = pc.GSPLAT_RENDERER_RASTER_GPU_SORT;
        params.splatBudget = options.maxSplats;
        params.lodMode = pc.GSPLAT_LODMODE_DISTANCE;
        params.lodBehindPenalty = 5;
        params.lodUpdateAngle = 90;
        params.lodUnderfillLimit = 0;
        params.minContribution = 1;
        params.alphaClip = 1 / 255;
        params.foveationStrength = 0;
        params.radialSorting = true;
        params.antiAlias = false;
        const camera = new pc.Entity("comparison-camera", app);
        camera.addComponent("camera", {
            fov: (FOV * 180) / Math.PI,
            horizontalFov: false,
            nearClip: NEAR,
            farClip: FAR,
            clearColor: new pc.Color(0, 0, 0, 1),
        });
        app.root.addChild(camera);
        const asset = new pc.Asset("lod-meta.json", "gsplat", { url: options.assetUrl, filename: "lod-meta.json" });
        app.assets.add(asset);
        await waitForSplatLodDeadline(
            new Promise((resolve, reject) => {
                asset.once("load", resolve);
                asset.once("error", (reason) => reject(new Error(String(reason))));
                app.assets.load(asset);
            }),
            deadline,
            "PlayCanvas GSplat initialization"
        );
        const octree = asset.resource?.octree;
        if (!octree || octree.nodes.length !== rawLeaves.length) {
            app.destroy();
            throw new Error("Unexpected PlayCanvas octree/native leaf order");
        }
        const model = new pc.Entity("comparison-splats", app);
        model.setLocalEulerAngles(0, 0, 180);
        model.addComponent("gsplat", {
            unified: true,
            asset,
            lodRangeMin: manifest.lodLevels - 1,
            lodRangeMax: manifest.lodLevels - 1,
        });
        app.root.addChild(model);
        let bootstrapDone = false;
        let latestReady = null;
        let disposed = false;
        const resourceFiles = new WeakMap();
        const context = () => {
            const cameraData = app.renderer.gsplatDirector.camerasMap.get(camera.camera.camera);
            if (!cameraData) {
                return null;
            }
            for (const data of cameraData.layersMap.values()) {
                const manager = data.gsplatManager;
                if (!manager) {
                    continue;
                }
                for (const instance of manager.world._octreeInstances.values()) {
                    if (instance.octree === octree) {
                        return { manager, world: manager.world, instance };
                    }
                }
            }
            return null;
        };
        const onReady = (cameraComponent, _layer, ready, loadingCount) => {
            if (cameraComponent !== camera.camera) {
                return;
            }
            latestReady = { ready, loadingCount };
            if (!bootstrapDone && ready && loadingCount === 0) {
                bootstrapDone = true;
                model.gsplat.lodRangeMin = 0;
                model.gsplat.lodRangeMax = manifest.lodLevels - 1;
                app.renderNextFrame = true;
            }
        };
        app.systems.gsplat.on("frame:ready", onReady);
        app.autoRender = true;
        const setPose = (pose) => {
            const position = new pc.Vec3(pose.eye[0], pose.eye[1], -pose.eye[2]);
            const target = new pc.Vec3(pose.target[0], pose.target[1], -pose.target[2]);
            camera.setPosition(position);
            camera.lookAt(target, new pc.Vec3(0, 1, 0));
            app.renderNextFrame = true;
        };
        setPose(requestedPose(initialWaypoint, overviewTarget(manifest)));
        app.start();
        const snapshot = (pose) => {
            const current = context();
            if (!current) {
                return null;
            }
            const { world, instance } = current;
            const state = world.getState(world.currentVersion);
            for (const [fileIndex, resource] of octree.fileResources) {
                resourceFiles.set(resource, fileIndex);
            }
            const resolved = rawLeaves.map(() => []);
            if (state) {
                for (const info of state.splats) {
                    if (info.octreeNodes !== octree.nodes || info.parentPlacementId !== instance.placement.allocId) {
                        continue;
                    }
                    const file = resourceFiles.get(info.resource);
                    if (file === undefined) {
                        throw new Error("Unidentified PlayCanvas resolved source resource");
                    }
                    for (let interval = 0; interval < info.intervalNodeIndices.length; interval++) {
                        const leafIndex = info.intervalNodeIndices[interval];
                        const offset = info.intervals[interval * 2];
                        const count = info.intervals[interval * 2 + 1] - offset;
                        const matches = Object.entries(rawLeaves[leafIndex].raw.lods)
                            .filter(([, value]) => value.file === file && value.offset === offset && value.count === count)
                            .map(([lod]) => Number(lod));
                        if (matches.length !== 1) {
                            throw new Error(`Unmappable PlayCanvas resolved tuple for leaf ${leafIndex}`);
                        }
                        resolved[leafIndex].push(matches[0]);
                    }
                }
            }
            const loader = octree.assetLoader;
            const leaves = rawLeaves.map(({ path, raw }, index) => {
                const node = instance.nodeInfos[index];
                const targetLod = Number(node.optimalLod);
                const requestedLod = Number(instance.selectDesiredLodIndex(index, node.optimalLod, params.lodUnderfillLimit));
                const bound = transformTrogirManifestBound(raw.bound);
                const visible = intersectsComparisonFrustum(bound, pose.eye, pose.target, FOV, options.width / options.height, NEAR, FAR);
                const resolvedLods = resolved[index];
                const displayedLod = resolvedLods.length === 1 ? resolvedLods[0] : null;
                const target = raw.lods[String(targetLod)];
                const displayed = displayedLod === null ? null : raw.lods[String(displayedLod)];
                const targetUrl = target?.count > 0 ? sourceUrl(options.assetUrl, manifest, target.file) : null;
                return {
                    id: path,
                    index,
                    visible,
                    nativeVisible: null,
                    distance: distanceToComparisonBound(pose.eye, bound),
                    targetLod: target?.count > 0 ? targetLod : null,
                    requestedLod: raw.lods[String(requestedLod)]?.count > 0 ? requestedLod : null,
                    displayedLod,
                    resolvedLods,
                    targetCount: target?.count > 0 ? target.count : null,
                    displayedCount: displayed?.count ?? null,
                    targetSourceState: targetUrl ? sourceState(octree, loader, targetUrl, target.file) : "empty",
                    residentLods: Object.entries(raw.lods)
                        .filter(([, value]) => value.count > 0 && octree.fileResources.has(value.file))
                        .map(([lod]) => Number(lod)),
                    gap: target?.count > 0 && displayedLod !== null ? displayedLod - targetLod : null,
                };
            });
            return {
                state,
                world,
                instance,
                leaves,
                queuedFiles: loader._loadQueue.length,
                loadingFiles: loader._currentlyLoading.size,
                failedFiles: loader._failed.size,
                pendingTransitions: instance.pendingDecrements.size + instance.pendingVisibleAdds.size,
                latestReady,
                bootstrapDone,
                activeSplats: state?.totalActiveSplats ?? 0,
                residentGpuBytes: Object.values(device._vram).reduce((sum, value) => sum + (Number(value) || 0), 0),
            };
        };
        const gpuErrors = [];
        const rawDevice = device.wgpu;
        const onGpuError = (event) => {
            event.preventDefault();
            gpuErrors.push(event.error.message);
        };
        rawDevice?.addEventListener("uncapturederror", onGpuError);
        const dispose = () => {
            if (disposed) {
                return;
            }
            disposed = true;
            rawDevice?.removeEventListener("uncapturederror", onGpuError);
            app.systems.gsplat.off("frame:ready", onReady);
            app.destroy();
        };
        return { pc, app, camera, manifest, rawLeaves, setPose, snapshot, gpuErrors, dispose };
    } catch (error) {
        if (app) {
            app.destroy();
        } else {
            device?.destroy?.();
        }
        throw error;
    }
}

/** Runs pinned native PlayCanvas diagnostics without adding it to any product dependency graph. */
export async function runPlayCanvasLodComparison(options, emit) {
    let reference = null;
    const summaries = [];
    const { waypoints, ...settings } = options;
    const initializationStartedAt = performance.now();
    try {
        reference = await createReference(options, initializationStartedAt + options.timeoutMs, waypoints[0]);
        const center = overviewTarget(reference.manifest);
        for (let waypointIndex = 0; waypointIndex < waypoints.length; waypointIndex++) {
            const waypoint = waypoints[waypointIndex];
            const sampleSequence = waypointIndex === 0 ? "cold" : "warm";
            const pose = requestedPose(waypoint, center);
            if (waypointIndex > 0) {
                reference.setPose(pose);
            }
            const startedAt = waypointIndex === 0 ? initializationStartedAt : performance.now();
            let changedAt = startedAt;
            let emittedAt = -Infinity;
            let previousFingerprint = "";
            let final;
            for (;;) {
                await new Promise((resolve) => setTimeout(resolve, options.sampleMs));
                const now = performance.now();
                const native = reference.snapshot(pose);
                if (!native) {
                    if (now - startedAt >= options.timeoutMs) {
                        throw new Error(`PlayCanvas did not create a GSplat world for ${waypoint.name}`);
                    }
                    continue;
                }
                const visible = native.leaves.filter((leaf) => leaf.visible);
                const gapLeaves = countSplatLodTargetDisplayGaps(visible);
                const targetSum = native.leaves.reduce((sum, leaf) => sum + (leaf.targetCount ?? 0), 0);
                const pendingRequests = native.loadingFiles + native.pendingTransitions;
                const actualMatrix = Array.from(reference.camera.getWorldTransform().data);
                const error = reference.gpuErrors[0] ?? (native.failedFiles ? `${native.failedFiles} failed source(s)` : null);
                const sample = {
                    type: "sample",
                    schemaVersion: 1,
                    engine: "playcanvas",
                    engineVersion: `${reference.pc.version}/${reference.pc.revision}`,
                    sequence: sampleSequence,
                    profile: options.profile,
                    waypoint: waypoint.name,
                    elapsedMs: Math.round(now - startedAt),
                    phase: native.bootstrapDone ? (native.latestReady?.ready ? "ready" : "streaming") : "bootstrap",
                    disposition: "sampling",
                    queuedFiles: native.queuedFiles,
                    pendingRequests,
                    selectedSplats: targetSum,
                    activeSplats: native.activeSplats,
                    residentGpuBytes: native.residentGpuBytes,
                    allocatedGpuBytes: null,
                    pressure: false,
                    error,
                    camera: {
                        requestedEye: pose.eye,
                        requestedTarget: pose.target,
                        actualWorldMatrix: actualMatrix,
                        fov: FOV,
                        near: NEAR,
                        far: FAR,
                        viewport: [options.width, options.height],
                        dpr: options.dpr,
                    },
                    leaves: native.leaves,
                };
                const nextFingerprint = fingerprint(sample);
                const changed = nextFingerprint !== previousFingerprint;
                if (changed) {
                    previousFingerprint = nextFingerprint;
                    changedAt = now;
                }
                const quiet = now - changedAt >= options.quietMs;
                const settledNative =
                    native.bootstrapDone &&
                    native.latestReady?.ready === true &&
                    native.queuedFiles === 0 &&
                    pendingRequests === 0 &&
                    native.world.currentVersion === native.world.lastWorldStateVersion &&
                    !native.world.awaitingLodUpdate;
                const timedOut = now - startedAt >= options.timeoutMs;
                const disposition = classifySplatLodOutcome({
                    timedOut,
                    quiet,
                    ready: settledNative,
                    pressure: false,
                    error,
                    queuedFiles: native.queuedFiles,
                    pendingRequests,
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
                throw new Error(`PlayCanvas comparison failed at ${waypoint.name}: ${final.error}`);
            }
            const visible = final.leaves.filter((leaf) => leaf.visible);
            summaries.push({
                name: waypoint.name,
                disposition: final.disposition,
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
            engine: "playcanvas",
            engineVersion: `${reference.pc.version}/${reference.pc.revision}`,
            sequence: options.sequence,
            profile: options.profile,
            assetUrl: options.assetUrl,
            settings,
            waypoints: summaries,
        };
    } finally {
        reference?.dispose();
    }
}
