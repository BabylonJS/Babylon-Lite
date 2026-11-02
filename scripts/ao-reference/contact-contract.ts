export interface ContactFrame {
    actual: (number | null)[];
    spatial: (number | null)[];
}

export function parseContactOptions(args: readonly string[]): { software: boolean } {
    if (args.some((arg) => arg !== "--software") || args.length > 1) {
        throw new Error("Contact AO validation accepts only one optional --software flag.");
    }
    return { software: args.includes("--software") };
}

function checkedFrames(frames: readonly ContactFrame[]): number[] {
    if (frames.length < 24 || !frames[0]?.actual.length) throw new Error("Contact metrics require at least 24 nonempty frames.");
    const size = frames[0].actual.length;
    for (const frame of frames) {
        if (frame.actual.length !== size || frame.spatial.length !== size) throw new Error("Contact trace dimensions differ.");
        for (let i = 0; i < size; i++) {
            const a = frame.actual[i]!,
                b = frame.spatial[i]!;
            if ((a === null) !== (b === null)) throw new Error("Contact temporal/spatial coverage differs.");
            if (a !== null && (!Number.isFinite(a) || a < 0 || a > 1 || b === null || !Number.isFinite(b) || b < 0 || b > 1)) {
                throw new Error("Contact traces contain invalid visibility.");
            }
        }
    }
    const ids = frames[0].actual.map((_, i) => i).filter((i) => frames.every((frame) => frame.actual[i] !== null));
    if (ids.length < Math.ceil(size / 2)) throw new Error(`Insufficient consistent contact-floor coverage: ${ids.length}/${size}.`);
    return ids;
}

export function summarizeContact(frames: readonly ContactFrame[]) {
    const ids = checkedFrames(frames);
    const curvature: number[] = [],
        spatial: number[] = [],
        pointRms: number[] = [];
    const patch = frames.map((frame) => ids.reduce((sum, i) => sum + frame.actual[i]!, 0) / ids.length);
    for (const id of ids) {
        let squared = 0;
        for (let f = 2; f < frames.length; f++) {
            const d = frames[f]!.actual[id]! - 2 * frames[f - 1]!.actual[id]! + frames[f - 2]!.actual[id]!;
            const s = frames[f]!.spatial[id]! - 2 * frames[f - 1]!.spatial[id]! + frames[f - 2]!.spatial[id]!;
            curvature.push(d);
            spatial.push(s);
            squared += d * d;
        }
        pointRms.push(Math.sqrt(squared / (frames.length - 2)));
    }
    const rms = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    pointRms.sort((a, b) => a - b);
    return {
        frames: frames.length,
        samples: ids.length,
        meanVisibility: patch.reduce((sum, value) => sum + value, 0) / patch.length,
        temporalSecondDifferenceRms: rms(curvature),
        spatialSecondDifferenceRms: rms(spatial),
        p95PointSecondDifferenceRms: pointRms[Math.min(pointRms.length - 1, Math.floor(pointRms.length * 0.95))]!,
        patchSecondDifferenceRms: rms(patch.slice(2).map((value, i) => value - 2 * patch[i + 1]! + patch[i]!)),
    };
}

export function contactViolations(metrics: ReturnType<typeof summarizeContact>): string[] {
    return (
        [
            ["temporalSecondDifferenceRms", 1 / 255],
            ["p95PointSecondDifferenceRms", 1.5 / 255],
            ["patchSecondDifferenceRms", 0.1 / 255],
        ] as const
    ).flatMap(([key, limit]) => {
        return !Number.isFinite(metrics[key]) || metrics[key] > limit ? [`${key}=${metrics[key]} exceeds ${limit}`] : [];
    });
}

/** Separate slow stale-shadow error from high-frequency shimmer. */
export function summarizeContactTrail(previous: readonly (number | null)[], current: readonly (number | null)[], observed: ContactFrame) {
    if (!current.length || previous.length !== current.length || observed.actual.length !== current.length || observed.spatial.length !== current.length) {
        throw new Error("Contact trailing dimensions differ.");
    }
    let samples = 0,
        temporal = 0,
        spatial = 0,
        residual = 0;
    for (let i = 0; i < current.length; i++) {
        const old = previous[i]!,
            mean = current[i]!,
            actual = observed.actual[i]!,
            raw = observed.spatial[i]!;
        if ([old, mean, actual, raw].some((value) => value !== null && (!Number.isFinite(value) || value < 0 || value > 1))) {
            throw new Error("Contact trailing contains invalid visibility.");
        }
        if (old === null || mean === null || actual === null || raw === null || old >= 0.94 || mean - old <= 0.04) continue;
        samples++;
        temporal += Math.max(0, mean - actual);
        spatial += Math.max(0, mean - raw);
        residual += (mean - actual) ** 2;
    }
    if (samples < 16) throw new Error(`Insufficient newly lit contact receivers: ${samples}.`);
    return { samples, temporalTrail: temporal / samples, spatialTrail: spatial / samples, excessTrail: (temporal - spatial) / samples, residualRms: Math.sqrt(residual / samples) };
}

export function adaptContactDemo(source: string): string {
    const marker = "    await startEngine(engine);";
    if (source.split(marker).length !== 2) throw new Error("Contact AO demo hook must occur exactly once.");
    const lighting = `    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        brdfUrl: "/brdf-lut.png",
        skipSkybox: true,
        skipGround: true,
    });`;
    if (source.split(lighting).length !== 2) throw new Error("Contact AO lighting hook must occur exactly once.");
    source = source.replace(lighting, "");
    return (
        `import { exposeContactValidation } from "../../../../scripts/ao-reference/validate-contact-client.js";\n` +
        source.replace(marker, "    exposeContactValidation(engine, ao, temporal, camera, sphere);")
    );
}
