export interface SplatLodWaypoint {
    readonly name: string;
    readonly eye?: readonly [number, number, number];
    readonly target?: readonly [number, number, number];
    readonly yawDegrees?: number;
    readonly pitchDegrees?: number;
}

export function formatSplatLodRuntimeError(engine: string, message: string): string {
    return `${engine} browser runtime error: ${message}`;
}

export interface SplatLodComparisonOptions {
    readonly codeRevision: string;
    readonly workingTreeDirty: boolean;
    readonly assetUrl: string;
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly maxSplats: number;
    readonly maxGpuBytes: number;
    readonly maxCpuBytes: number;
    readonly screenError: number;
    readonly sampleMs: number;
    readonly quietMs: number;
    readonly timeoutMs: number;
    readonly waypoints: readonly SplatLodWaypoint[];
    readonly sequence: "cold" | "warm";
    readonly profile: "matched-budget" | "viewer-budget";
}

export interface SplatLodCameraRecord {
    readonly requestedEye: readonly [number, number, number];
    readonly requestedTarget: readonly [number, number, number];
    readonly actualWorldMatrix: readonly number[];
    readonly fov: number;
    readonly near: number;
    readonly far: number;
    readonly viewport: readonly [number, number];
    readonly dpr: number;
}

export interface SplatLodLeafRecord {
    readonly id: string;
    readonly index: number;
    readonly visible: boolean;
    readonly nativeVisible: boolean | null;
    readonly distance: number;
    readonly targetLod: number | null;
    readonly requestedLod: number | null;
    readonly displayedLod: number | null;
    readonly resolvedLods: readonly number[];
    readonly targetCount: number | null;
    readonly displayedCount: number | null;
    readonly targetSourceState: string | null;
    readonly residentLods: readonly number[];
    readonly gap: number | null;
}

export interface SplatLodSampleRecord {
    readonly type: "sample";
    readonly schemaVersion: 1;
    readonly engine: "babylon-lite" | "playcanvas";
    readonly engineVersion: string;
    readonly sequence: "cold" | "warm";
    readonly profile: "matched-budget" | "viewer-budget";
    readonly waypoint: string;
    readonly elapsedMs: number;
    readonly phase: string;
    readonly disposition: "sampling" | "converged" | "budget-limited" | "stalled" | "timeout" | "failed";
    readonly queuedFiles: number;
    readonly pendingRequests: number;
    readonly selectedSplats: number;
    readonly activeSplats: number;
    readonly residentGpuBytes: number | null;
    readonly allocatedGpuBytes: number | null;
    readonly pressure: boolean;
    readonly error: string | null;
    readonly camera: SplatLodCameraRecord;
    readonly leaves: readonly SplatLodLeafRecord[];
}

export interface SplatLodRunSummary {
    readonly engine: "babylon-lite" | "playcanvas";
    readonly engineVersion: string;
    readonly sequence: "cold" | "warm";
    readonly profile: "matched-budget" | "viewer-budget";
    readonly assetUrl: string;
    readonly settings: Omit<SplatLodComparisonOptions, "waypoints">;
    readonly waypoints: readonly {
        readonly name: string;
        readonly disposition: Exclude<SplatLodSampleRecord["disposition"], "sampling">;
        readonly elapsedMs: number;
        readonly visibleLeaves: number;
        readonly targetDisplayGapLeaves: number;
        readonly nearest: readonly SplatLodLeafRecord[];
        readonly targetHistogram: Readonly<Record<string, number>>;
        readonly displayedHistogram: Readonly<Record<string, number>>;
        readonly distanceBins: Readonly<
            Record<
                string,
                {
                    readonly visibleLeaves: number;
                    readonly targetDisplayGapLeaves: number;
                    readonly targetHistogram: Readonly<Record<string, number>>;
                    readonly displayedHistogram: Readonly<Record<string, number>>;
                }
            >
        >;
    }[];
}

export const DEFAULT_SPLAT_LOD_WAYPOINTS: readonly SplatLodWaypoint[] = [
    { name: "overview" },
    { name: "user", eye: [15.8, 1.68, -70.5], yawDegrees: 75.83, pitchDegrees: -10.43 },
    { name: "published-street", eye: [14.7745447, 1.5231726, -42.5117302], target: [16.2620824, 1.3343776, -43.8352073] },
    { name: "overview-return" },
    { name: "user-repeat", eye: [15.8, 1.68, -70.5], yawDegrees: 75.83, pitchDegrees: -10.43 },
];
