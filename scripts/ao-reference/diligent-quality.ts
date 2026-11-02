export interface DiligentQualityMetric {
    floorFlickerRms: number;
    floorResidualRms: number;
    maximumExcessTrail: number;
    pairs: number;
}

/** Moving noise and trails are independent requirements; one cannot pay for the other. */
export function diligentQualityProblems(quality: Record<string, DiligentQualityMetric>, held: Record<string, number>): string[] {
    const problems: string[] = [];
    for (const lane of ["blite", "shared", "clipped"]) {
        const metric = quality[lane];
        if (
            !metric ||
            !Number.isFinite(metric.floorFlickerRms) ||
            !Number.isFinite(metric.floorResidualRms) ||
            !Number.isFinite(metric.maximumExcessTrail) ||
            !Number.isInteger(metric.pairs) ||
            metric.pairs < 100 ||
            metric.floorFlickerRms < 0 ||
            metric.floorResidualRms < 0 ||
            metric.maximumExcessTrail < 0 ||
            !Number.isFinite(held[lane]) ||
            held[lane]! < 0
        ) {
            problems.push(`Invalid or insufficient ${lane} quality data.`);
        }
    }
    if (problems.length) {
        return problems;
    }
    const candidate = quality.clipped!;
    if (candidate.floorFlickerRms > quality.shared!.floorFlickerRms * 1.1) {
        problems.push("History clipping reintroduced moving-floor shimmer.");
    }
    if (held.clipped! > held.shared! * 1.1) {
        problems.push("History clipping destabilized a stationary floor.");
    }
    for (const lane of ["blite", "clipped"]) {
        const metric = quality[lane]!;
        if (metric.maximumExcessTrail > 0.015) {
            problems.push(`${lane} retained too much stale occlusion.`);
        }
        if (metric.floorFlickerRms > 0.01 || metric.floorResidualRms > 0.02) {
            problems.push(`${lane} exceeded the close-up noise/signal budget.`);
        }
    }
    return problems;
}
