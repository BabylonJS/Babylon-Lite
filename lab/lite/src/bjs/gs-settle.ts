// Deterministic readiness helper for the Gaussian-Splatting BJS *reference*
// pages (scenes 127/128/129).
//
// Why this exists: a `GaussianSplattingMesh` runs a Web Worker that sorts splats
// by depth asynchronously. The old reference code polled the private
// `_canPostToWorker` flag (which only means "the worker can accept a new sort",
// NOT "a sort has been applied and uploaded") and then awaited a single frame.
// On the slow software-rendered CI browser that could capture the page mid-sort,
// so the splat's depth ordering varied run-to-run — a flaky live reference.
// (The separate black-reference bug on the depth scenes was a missing GS
// depth-pass shader registration, fixed in scene127/128 directly.)
//
// `GaussianSplattingMeshBase` in @babylonjs/core 9.19.0 exposes the internal
// getter `_isDepthSortSettled` (`_readyToDisplay && !_sortIsDirty &&
// _canPostToWorker`) whose own docstring cites "deterministic screenshots". We
// poll it, held stable across several *rendered* frames, so the first depth sort
// is applied+uploaded and the depth RTT is fully populated before we capture.
// We feature-detect the getter and fall back to the underlying per-camera sort
// bookkeeping in case a build omits it.
import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

interface CameraViewInfo {
    splatIndexBufferSet: boolean;
    sortAppliedId: number;
    sortRequestId: number;
}

interface GsSettleInternals {
    _isDepthSortSettled?: boolean;
    _readyToDisplay?: boolean;
    _sortIsDirty?: boolean;
    _canPostToWorker?: boolean;
    _cameraViewInfos?: Map<number, CameraViewInfo>;
}

function isSettled(gs: GsSettleInternals): boolean {
    // Prefer the purpose-built getter when the installed build exposes it.
    if (typeof gs._isDepthSortSettled === "boolean") {
        if (!gs._isDepthSortSettled) {
            return false;
        }
    } else if (!(gs._readyToDisplay === true && gs._sortIsDirty !== true && gs._canPostToWorker === true)) {
        // Fallback: the flags the getter is composed of.
        return false;
    }
    // Cross-check every camera's sort has actually been applied+uploaded.
    const views = gs._cameraViewInfos;
    if (views) {
        for (const v of views.values()) {
            if (!v.splatIndexBufferSet || v.sortAppliedId !== v.sortRequestId) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Resolve once a Gaussian-Splatting mesh has produced a settled, stable frame:
 * its first depth sort is applied+uploaded and the sort has stayed settled for
 * `stableFrames` consecutive rendered frames (which also guarantees the depth
 * RTT is populated). Bounded by `timeoutMs` so a page never hangs the capture.
 *
 * @param scene - the reference scene (drives the render loop we sample).
 * @param gs - the Gaussian-Splatting mesh (`result.meshes[0]`).
 * @param opts.stableFrames - consecutive settled frames required (default 3).
 * @param opts.timeoutMs - upper bound before giving up (default 10000).
 */
export async function waitForGsSettled(scene: Scene, gs: AbstractMesh, opts: { stableFrames?: number; timeoutMs?: number } = {}): Promise<void> {
    const stableTarget = opts.stableFrames ?? 3;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const internals = gs as unknown as GsSettleInternals;
    const start = performance.now();
    let stable = 0;
    while (stable < stableTarget) {
        // Advance exactly one rendered frame, then sample. The worker's onmessage
        // handler runs on the task queue between frames, so real rendered frames
        // are what let an in-flight sort actually land.
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
        stable = isSettled(internals) ? stable + 1 : 0;
        if (performance.now() - start > timeoutMs) {
            break;
        }
    }
}
