/**
 * Shared ceiling-headroom arithmetic for the bundle-size build log and the PR comment.
 *
 * Headroom is the distance between a scene's measured runtime size and its `maxRawKB`
 * ceiling in `scene-config.json`. The ceiling check itself is absolute and lives elsewhere
 * (`tests/lite/parity/bundle-size.spec.ts` and `reportCeilingHeadroom` in
 * `bundle-scenes-core.ts`); nothing here decides whether a build passes or fails. This
 * module exists so the two places that *report* headroom — a build log and a GitHub
 * comment — cannot drift apart on thresholds or on the rounding rules below.
 *
 * ## Why headroom is worth reporting at all
 *
 * The ceilings are, in practice, ratchets pinned to whatever each scene measured when it
 * was last touched, not budgets with slack. Measured across the 241 scenes that have both a
 * size and a ceiling, from ADO build 58227 — the first run to measure every scene at a single
 * master commit rather than relying on per-scene manifests each author regenerated at a
 * different time:
 *
 *   median headroom   1536 B      p25   205 B      p10   113 B
 *   under  256 B       71 scenes (29%)
 *   under 1024 B      105 scenes (44%)
 *   under 2048 B      131 scenes (54%)
 *
 * The tightest scene on master sits 9 bytes below its ceiling.
 * * That distribution is what makes concurrent PRs dangerous. Two PRs can each measure under
 * a ceiling — each was built against a master that did not contain the other — and breach
 * it together once both land. Azure DevOps builds the *merge commit* for a PR, so once
 * master is over a ceiling, every subsequent PR's Bundle Size job fails until the bytes are
 * recovered. The recovery options are emergency size work or raising a ceiling, and raising
 * a ceiling requires explicit user approval (see GUIDANCE.md). Making headroom visible at
 * review time is what lets an author notice they are in the danger zone and serialize on
 * purpose instead of discovering it from a repo-wide stall.
 */

/**
 * Headroom below which a scene is reported as tight.
 *
 * Chosen as one kilobyte because that is exactly the granularity at which the existing
 * reporting goes blind: the PR delta table rounds every size to a whole KB, so a scene with
 * less than 1 KB of headroom can be pushed over its ceiling by a change the table renders as
 * `0 KB` or `+1 KB`. Below this line an author cannot see the risk from the numbers they are
 * shown, which is precisely where a warning earns its place.
 *
 * It is also where the population splits: median headroom is 1536 B, so 1 KB flags the tight
 * ~44% and stays quiet about the roomy half. The previous value of 256 B was not a "quiet"
 * threshold — it already flagged 71 scenes — it was just an arbitrary point well inside the
 * risk band, and it said nothing about the ~1 KB range where most near-ceiling scenes
 * actually sit. Raising further was rejected: 2 KB flags 54% of scenes and 4 KB flags 72%,
 * at which point the warning is wallpaper nobody reads.
 *
 * This is a WARNING threshold. It is not a ceiling and it never fails a build.
 */
export const TIGHT_HEADROOM_BYTES = 1024;

/**
 * Inner band, reported as a count alongside the tight count.
 *
 * This is the old tight threshold, kept rather than deleted: at under a quarter kilobyte a
 * scene is not merely at risk from an unrelated shared-path change, it is effectively
 * guaranteed to move with the next one. Splitting the report into "tight" and "critical"
 * keeps that emergency signal legible now that the outer band is four times wider.
 */
export const CRITICAL_HEADROOM_BYTES = 256;

/**
 * How many scenes to name explicitly before collapsing the rest into a count.
 *
 * The tight set is ~105 scenes on master and would swamp both a build log and a PR comment
 * if listed in full. Naming a fixed handful of the tightest and counting the remainder keeps
 * the output a constant size no matter how the flagged set grows, so widening the threshold
 * changes the numbers in the report without changing how much of it there is to read.
 *
 * Build 58227 shows the failure this avoids: at the old 256 B threshold its log already had to
 * truncate, printing ten scenes and then "… and 61 more under 256 B".
 */
export const HEADROOM_LIST_LIMIT = 10;

/** The subset of a bundle manifest entry that headroom needs. */
export interface MeasuredSizeEntry {
    rawKB?: number;
    /** Exact runtime-fetched byte count, when the manifest recorded one. */
    rawBytes?: number;
}

export interface SceneHeadroomInput {
    /** Manifest key, e.g. `scene12`. */
    scene: string;
    /** Display label for reports; falls back to the manifest key. */
    name?: string;
    measuredBytes: number;
    ceilingKB: number;
    /**
     * The same measurement taken from the baseline, when the scene exists there at all.
     *
     * `undefined` means the scene is new on this branch, which is a distinct state from "the same
     * size as the baseline" and must not be conflated with it: a new scene has no baseline
     * behaviour to have inherited. Consumers that need to attribute a ceiling breach — was it
     * already broken, or did this change break it — read this rather than a movement delta,
     * because movement cannot answer the question. A scene absent from the baseline has no delta,
     * and a scene already over its ceiling still has a delta if the branch touched it at all.
     */
    masterBytes?: number;
}

export interface SceneHeadroom extends SceneHeadroomInput {
    /**
     * Bytes remaining under the ceiling for a scene that fits, floored; bytes by which the
     * ceiling is exceeded for one that does not, ceiled. Always a non-negative magnitude —
     * `over` and `under` distinguish the direction.
     */
    headroomBytes: number;
}

export interface SceneHeadroomReport {
    /** Scenes past their ceiling, tightest overflow first. */
    over: SceneHeadroom[];
    /** Scenes within their ceiling, least headroom first. */
    under: SceneHeadroom[];
}

/**
 * Exact measured bytes for a manifest entry, or `null` when it recorded no size.
 *
 * `rawKB` is rounded to 0.1 KB, which hides up to ~51 bytes of drift — enough to conceal a
 * ceiling overflow on a zero-headroom scene. Prefer the exact `rawBytes` the measurement
 * records and fall back to `rawKB` only for older entries that predate it, where a
 * 0.1 KB-quantised answer is still better than none.
 */
export function measuredBytesOf(entry: MeasuredSizeEntry | undefined): number | null {
    if (entry?.rawBytes != null) {
        return entry.rawBytes;
    }
    if (entry?.rawKB != null) {
        return entry.rawKB * 1024;
    }
    return null;
}

/**
 * Split scenes into those over their ceiling and those under it, sorted tightest-first.
 *
 * Comparison happens before any rounding. A ceiling of 92.2 KB is 94412.8 bytes, so a scene
 * measuring 94413 bytes is over by 0.2 — a difference `Math.round` would collapse to `-0`
 * and wave through.
 */
export function computeSceneHeadroom(inputs: readonly SceneHeadroomInput[]): SceneHeadroomReport {
    const over: SceneHeadroom[] = [];
    const under: SceneHeadroom[] = [];

    for (const input of inputs) {
        const ceilingBytes = input.ceilingKB * 1024;
        if (input.measuredBytes > ceilingBytes) {
            over.push({ ...input, headroomBytes: Math.ceil(input.measuredBytes - ceilingBytes) });
        } else {
            under.push({ ...input, headroomBytes: Math.floor(ceilingBytes - input.measuredBytes) });
        }
    }

    over.sort((a, b) => b.headroomBytes - a.headroomBytes);
    under.sort((a, b) => a.headroomBytes - b.headroomBytes);
    return { over, under };
}

/**
 * Scenes strictly below a headroom threshold, preserving the tightest-first order.
 *
 * Strict rather than inclusive, so the predicate reads the way the reports word it — "under
 * 1.0 KB" — and a scene sitting exactly on the boundary is not counted as having crossed it.
 */
export function scenesUnderHeadroom(under: readonly SceneHeadroom[], thresholdBytes: number): SceneHeadroom[] {
    return under.filter((s) => s.headroomBytes < thresholdBytes);
}

/** Render a byte threshold the way the reports name it, e.g. `1.0 KB` / `256 B`. */
export function formatHeadroomThreshold(bytes: number): string {
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
