export interface SampleSummary {
    readonly count: number;
    readonly minimum: number;
    readonly median: number;
    readonly p95: number;
    readonly maximum: number;
    readonly mean: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
    if (samples.length === 0) {
        return { count: 0, minimum: 0, median: 0, p95: 0, maximum: 0, mean: 0 };
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    return {
        count: sorted.length,
        minimum: sorted[0]!,
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        maximum: sorted[sorted.length - 1]!,
        mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    };
}

export function liveCount(created: number, released: number): number {
    return created - released;
}
