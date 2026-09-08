/**
 * Canonical capture state for Lite parity scenes.
 *
 * Both browser golden capture and the Shado/Dawn runner consume this table so
 * animation, physics, navigation, readiness, and settling cannot drift between
 * backends. An omitted scene uses the defaults below.
 */
export interface ParitySceneCaptureOptions {
    queryParams?: string;
    seekTime?: number;
    settleMs: number;
    timeoutMs: number;
    waitFlag?: string;
}

export const DEFAULT_PARITY_SCENE_CAPTURE_OPTIONS: Readonly<ParitySceneCaptureOptions> = {
    settleMs: 1_500,
    timeoutMs: 60_000,
};

const sceneCaptureOptions = new Map<number, Partial<ParitySceneCaptureOptions>>();

function assign(sceneIds: readonly number[], options: Partial<ParitySceneCaptureOptions>): void {
    for (const sceneId of sceneIds) {
        sceneCaptureOptions.set(sceneId, { ...sceneCaptureOptions.get(sceneId), ...options });
    }
}

assign([74, 75, 76, 142], { timeoutMs: 30_000 });
assign([26, 39, 90, 91, 113, 114, 117, 118, 220, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 256, 265], { timeoutMs: 90_000 });
assign([7, 8, 9, 11, 12, 13, 14, 20, 21, 24, 25, 27, 36, 66, 99, 115, 140, 143, 144, 145, 146, 147, 148, 149, 152, 157, 158, 168, 253, 254, 255, 257, 258, 259, 260, 261, 266], {
    timeoutMs: 120_000,
});
assign([120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 226], { timeoutMs: 150_000 });
assign([112, 166, 167, 170, 171, 172, 173, 174, 175, 179, 218, 219], { timeoutMs: 180_000 });

assign([52, 53, 54, 55, 56, 57, 58, 59, 81, 92, 93, 94, 95, 96, 97, 98, 99, 143, 150, 151, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 205, 206, 207, 209, 280, 281], {
    settleMs: 500,
});
assign([120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 226], { settleMs: 800 });
assign([90, 91, 113, 114, 115, 116, 117, 118, 166, 167, 179], { settleMs: 1_000 });
assign([112], { settleMs: 2_000 });
assign([27], { settleMs: 3_000 });
assign([144, 145, 146, 147, 148, 149], { settleMs: 5_000 });
assign([153], { settleMs: 100 });
assign([278, 279, 282, 283, 284], { settleMs: 300 });

assign([5], { seekTime: 2 });
assign([7], { seekTime: 2 });
assign([11], { seekTime: 1.91 });
assign([12], { seekTime: 0.5 });
assign([20, 23, 34], { seekTime: 0 });
assign([26], { seekTime: 3 });
assign([39], { seekTime: 5 });
assign([40], { queryParams: "captureFrame=120", waitFlag: "captureReady" });
assign([41], { queryParams: "captureFrame=10", waitFlag: "captureReady" });
assign([42, 43], { queryParams: "captureFrame=300", waitFlag: "captureReady" });
assign([44], { queryParams: "captureAfter=5", waitFlag: "captureReady" });
assign([45], { queryParams: "captureAfter=3", waitFlag: "captureReady" });
assign([46], { queryParams: "captureFrame=10", waitFlag: "captureReady" });
assign([47], { queryParams: "captureFrame=1", waitFlag: "captureReady" });
assign([48, 49], { queryParams: "capture=1", waitFlag: "captureReady" });
assign([58, 59], { seekTime: 0.72 });
assign([64, 66, 140, 171, 172, 173, 174, 175], { queryParams: "freeze=1" });
assign([100], { queryParams: "captureFrame=120", waitFlag: "captureReady" });
assign([101], { queryParams: "captureFrame=150", waitFlag: "captureReady" });
assign([102, 103], { queryParams: "captureFrame=5", waitFlag: "captureReady" });
assign([104], { queryParams: "captureFrame=35", waitFlag: "captureReady" });
assign([105], { queryParams: "captureFrame=55", waitFlag: "captureReady" });
assign([106], { queryParams: "captureFrame=20", waitFlag: "captureReady" });
assign([115], { seekTime: 100 / 60 });
assign([150, 153, 155], { seekTime: 1 });
assign([151], { seekTime: 0.5 });
assign([152], { seekTime: 1.91 });
assign([154], { seekTime: 0.75 });
assign([156], { seekTime: 1.25 });
assign([157, 158], { seekTime: 1.2 });
assign([211], { seekTime: 0.5 });
assign([218, 219], { seekTime: 1 });
assign([231], { seekTime: 0.5 });
assign([240], { seekTime: 0.5 });
assign([241], { seekTime: 2 });
assign([242, 243, 244, 245, 246], { seekTime: 1 });
assign([250], { seekTime: 5 });
assign([251], { seekTime: 0.5 });
assign([253], { seekTime: 1 });
assign([254], { seekTime: 2 });
assign([255], { seekTime: 1 });
assign([283, 284], { waitFlag: "animationFrozen" });
assign([302], { seekTime: 2 });

export function getParitySceneCaptureOptions(sceneId: number): ParitySceneCaptureOptions {
    return { ...DEFAULT_PARITY_SCENE_CAPTURE_OPTIONS, ...sceneCaptureOptions.get(sceneId) };
}

export function buildParitySceneQuery(options: Pick<ParitySceneCaptureOptions, "queryParams" | "seekTime">): string {
    const parts: string[] = [];
    if (options.seekTime !== undefined) {
        parts.push(`seekTime=${options.seekTime}`);
    }
    if (options.queryParams) {
        parts.push(options.queryParams);
    }
    return parts.length > 0 ? `?${parts.join("&")}` : "";
}
