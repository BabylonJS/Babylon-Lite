/** CSM static-cache refit gate.
 *
 *  Pure per-frame decision logic for the CSM static shadow cache: which casters are
 *  static vs dynamic, when a caster is promoted or demoted between those sets, and
 *  whether this frame must refit the cascades (recompute cascade matrices and re-render
 *  the static cache) or only redraw the dynamic overlay.
 *
 *  Deliberately free of GPU and engine types so consumers can unit-test the gate with
 *  plain objects. The GPU orchestration (task membership moves, texture copies, camera
 *  updates) lives in `csm-shadow-task-hooks.ts`, which drives this gate through the
 *  promote/demote callbacks.
 *
 *  Correctness invariant owned by the caller: cascade matrices, the receiver UBO and
 *  the shadow-camera versions may change ONLY on frames where `update()` returns
 *  `refit: true`. The dynamic overlay is depth-tested against the cached static depth,
 *  so both halves must be rendered with the same cameras or the shadows tear.
 */

/** Minimal caster shape the gate reads. Matches the fields `casterVersionSum` uses. */
export interface CsmRefitCaster {
    readonly worldMatrixVersion: number;
    readonly thinInstances?: { readonly _version: number } | null | undefined;
}

/** Options for {@link createCsmRefitGate}. */
export interface CsmRefitGateOptions {
    /** Accumulated sun-rotation angle (radians) since the last refit that forces the next one.
     *  The sun drifts a different float every frame in normal play, so an exact-equality light
     *  key would never hold; this epsilon is what lets the cache survive a slowly moving sun. */
    refitAngle: number;
    /** Wall-time floor: force a refit this many ms after the previous one. GPU-clock-animated
     *  casters (wind-swayed flora) classify as static, so their shadow only moves at refit
     *  cadence even while the light is paused. 0 disables the floor. */
    refitMaxIntervalMs: number;
    /** Consecutive quiet frames before a dynamic caster becomes demotion-pending. Default 120. */
    demoteQuietFrames?: number;
}

/** Decision for one frame. `refit` implies `renderDynamic`. */
export interface CsmRefitDecision {
    /** Recompute cascades, re-render the static cache, then copy + overlay. */
    refit: boolean;
    /** Copy the cache into the live map and re-render the dynamic overlay. When both flags
     *  are false the frame does nothing at all: the live map already holds correct depth. */
    renderDynamic: boolean;
}

/** Per-frame refit/partition gate for the CSM static shadow cache. */
export interface CsmRefitGate<M extends CsmRefitCaster> {
    /** Adopt a (possibly re-supplied) caster array. Identity-checked, so calling every frame
     *  is O(1) while the array is unchanged. New casters start dynamic; departed casters are
     *  forgotten; any membership change forces a refit on the next `update()` (a removed static
     *  caster's shadow would otherwise linger in the cache). Reordering or re-supplying the same
     *  members does not invalidate the cache. */
    syncCasters(casters: readonly M[]): void;
    /** Force a known caster into the dynamic set (bookkeeping only; the caller owns task
     *  membership). Used when a caster is re-registered into the dynamic overlay tasks. */
    markDynamic(caster: M): void;
    /** Current classification, for callers that build task membership from a carried gate. */
    isDynamic(caster: M): boolean;
    /** Whether the refit returned by the latest `update()` was caused by light drift alone (the angle
     *  epsilon or the wall-time floor): the camera, the caster set, the static partition and the scene
     *  content are exactly what the previous refit rendered, so a consumer may spread that refit's static
     *  re-render over several frames (`createCsmStaticRefitScheduler`) without any cascade drawing a
     *  stale partition. False after a frame without refit and after a refit with any other cause,
     *  including a demotion applied inside the refit. */
    lastRefitDriftOnly(): boolean;
    /** One walk over the synced casters: computes the static/dynamic version sums, promotes
     *  churning static casters (via `onPromote`, immediately), counts quiet frames, and decides
     *  refit/overlay. Pending demotions are applied (via `onDemote`) only inside a refit; they
     *  ride refits caused by something else, except that in a world with no other refit cause
     *  they may trigger one themselves once overdue by the quiet threshold (see `update`).
     *  No allocation while nothing changes. */
    update(
        lightDirX: number,
        lightDirY: number,
        lightDirZ: number,
        nowMs: number,
        cameraChanged: boolean,
        force: boolean,
        onPromote: (caster: M) => void,
        onDemote: (caster: M) => void
    ): CsmRefitDecision;
}

interface CasterSlot {
    /** Version sum (worldMatrixVersion + thin-instance version) seen last frame. */
    _last: number;
    _dynamic: boolean;
    /** Consecutive frames without a version change; only meaningful while dynamic. */
    _quiet: number;
}

function casterVersion(caster: CsmRefitCaster): number {
    // Same formula as `casterVersionSum`: bitwise coercion maps a missing thin-instance
    // version to zero without a branch.
    return caster.worldMatrixVersion + ~~(caster.thinInstances?._version as number);
}

/** Create a refit gate. One instance per CSM generator task state. */
export function createCsmRefitGate<M extends CsmRefitCaster>(options: CsmRefitGateOptions): CsmRefitGate<M> {
    const refitAngle = options.refitAngle;
    const refitMaxIntervalMs = options.refitMaxIntervalMs;
    const demoteQuietFrames = options.demoteQuietFrames ?? 120;

    const slots = new Map<M, CasterSlot>();
    let casters: readonly M[] = [];
    let lastStaticSum = 0;
    let lastDynamicSum = 0;
    let casterSetChanged = false;
    let hasRefit = false;
    // Normalized light direction captured at the last refit; the drift test compares raw
    // components first (exact, free) and only pays the acos when something moved.
    let refitDirX = 0;
    let refitDirY = 0;
    let refitDirZ = 0;
    let lastRefitMs = 0;
    let framesSinceRefit = 0;
    let lastDriftOnly = false;

    return {
        syncCasters(next: readonly M[]): void {
            if (next === casters) {
                return;
            }
            // Prune departed casters before admitting new ones, so a swapped array of the
            // same meshes costs two walks and no churn. The Set is allocated only here, on
            // an actual re-supply, never in the steady frame path.
            const nextSet = new Set(next);
            let membershipChanged = nextSet.size !== slots.size;
            for (const m of slots.keys()) {
                if (!nextSet.has(m)) {
                    slots.delete(m);
                    membershipChanged = true;
                }
            }
            for (const m of next) {
                if (!slots.has(m)) {
                    // New casters start dynamic: their content is not in the cache yet, and
                    // the overlay renders them immediately without waiting for a refit.
                    slots.set(m, { _last: casterVersion(m), _dynamic: true, _quiet: 0 });
                    membershipChanged = true;
                }
            }
            casters = next;
            casterSetChanged ||= membershipChanged;
        },
        markDynamic(caster: M): void {
            const slot = slots.get(caster);
            if (slot && !slot._dynamic) {
                slot._dynamic = true;
                slot._quiet = 0;
            }
        },
        isDynamic(caster: M): boolean {
            return slots.get(caster)?._dynamic ?? true;
        },
        lastRefitDriftOnly(): boolean {
            return lastDriftOnly;
        },
        update(
            lightDirX: number,
            lightDirY: number,
            lightDirZ: number,
            nowMs: number,
            cameraChanged: boolean,
            force: boolean,
            onPromote: (caster: M) => void,
            onDemote: (caster: M) => void
        ): CsmRefitDecision {
            framesSinceRefit++;
            let staticSum = 0;
            let dynamicSum = 0;
            let dynamicChanged = false;
            let promoted = false;
            let pendingDemotions = 0;
            for (const m of casters) {
                const slot = slots.get(m)!;
                const v = casterVersion(m);
                const changed = v !== slot._last;
                slot._last = v;
                if (slot._dynamic) {
                    dynamicChanged ||= changed;
                    slot._quiet = changed ? 0 : slot._quiet + 1;
                    if (slot._quiet >= demoteQuietFrames) {
                        pendingDemotions++;
                    }
                    dynamicSum += v;
                } else if (changed) {
                    // A static caster churned: promote immediately. Its depth is baked into
                    // the cache at its OLD transform, so this frame must also refit (the
                    // `promoted` flag below) to re-render the cache without it.
                    slot._dynamic = true;
                    slot._quiet = 0;
                    promoted = true;
                    onPromote(m);
                    dynamicSum += v;
                } else {
                    staticSum += v;
                }
            }

            // Drift detection compares raw components against the refit snapshot: exact and
            // free. The angle (an acos) is computed only when the light actually moved.
            const len = Math.hypot(lightDirX, lightDirY, lightDirZ) || 1;
            const nx = lightDirX / len;
            const ny = lightDirY / len;
            const nz = lightDirZ / len;
            const drifted = hasRefit && (nx !== refitDirX || ny !== refitDirY || nz !== refitDirZ);
            let angleExceeded = false;
            if (drifted) {
                const dot = Math.min(1, Math.max(-1, nx * refitDirX + ny * refitDirY + nz * refitDirZ));
                angleExceeded = Math.acos(dot) > refitAngle;
            }
            // NOT gated on `drifted`: GPU-clock-animated casters (wind-swayed flora, see the header
            // note) change their cast silhouette every frame with no CPU-visible version bump, so the
            // wall-time floor is their ONLY refresh. Gating it on light drift froze their cached shadow
            // at the last refit's wind phase whenever the sun was paused — the first camera move then
            // snapped every canopy shadow at once (measured: roof 14 luma dark at rest, truth restored
            // to 0.01 luma by this line alone; cost is the floor's own designed cadence).
            const intervalElapsed = refitMaxIntervalMs > 0 && nowMs - lastRefitMs >= refitMaxIntervalMs;
            // Demotions normally ride refits caused by something else, but a fully frozen world
            // (paused sun, still camera) never refits again, so its pending demotions would park
            // forever and the overlay would keep redrawing every quiet caster each churn frame.
            // Measured on the playtest save: the full 566-caster overlay persisted indefinitely.
            // So pending demotions may trigger ONE refit themselves, rate-limited to the quiet
            // threshold so an oscillating caster costs at most one extra refit per quiet period.
            const demotionOverdue = pendingDemotions > 0 && framesSinceRefit >= demoteQuietFrames;

            const membershipCause = force || !hasRefit || casterSetChanged || promoted || staticSum !== lastStaticSum || cameraChanged || demotionOverdue;
            const refit = membershipCause || angleExceeded || intervalElapsed;
            let demoted = 0;

            if (refit) {
                // Demotions ride refits that happen anyway: moving a caster into the static
                // set only takes effect when the cache is re-rendered, so applying them on a
                // quiet frame would either tear or force an extra refit for nothing.
                for (const m of casters) {
                    const slot = slots.get(m)!;
                    if (slot._dynamic && slot._quiet >= demoteQuietFrames) {
                        slot._dynamic = false;
                        onDemote(m);
                        demoted++;
                        // Keep the recorded sums consistent with the new partition, or the
                        // next frame would read the membership change as fresh churn and
                        // refit again.
                        staticSum += slot._last;
                        dynamicSum -= slot._last;
                    }
                }
                hasRefit = true;
                casterSetChanged = false;
                refitDirX = nx;
                refitDirY = ny;
                refitDirZ = nz;
                lastRefitMs = nowMs;
                framesSinceRefit = 0;
            }

            const renderDynamic = refit || dynamicChanged || dynamicSum !== lastDynamicSum;
            // A demotion applied inside a drift refit moves a caster between the dynamic and static layers,
            // which is a membership change for the static render: it disqualifies the spread as well.
            lastDriftOnly = refit && !membershipCause && demoted === 0;
            lastStaticSum = staticSum;
            lastDynamicSum = dynamicSum;
            return { refit, renderDynamic };
        },
    };
}

/** Which static cascades to re-render this frame when a refit is spread over several frames. */
export interface CsmStaticRefitScheduler {
    /** A refit decision landed. `spread` true keeps the per-frame budget (a drift-only refit);
     *  false re-renders every cascade in the very next `take()` (any other refit cause). */
    arm(spread: boolean): void;
    /** Some cascade still waits for its static re-render. */
    pending(): boolean;
    /** The cascades to re-render now, in round-robin order so no cascade can starve when refits
     *  arrive faster than the budget drains; each returned cascade leaves the pending set. */
    take(): number[];
    /** The largest number of frames a cascade can lag behind the refit that armed it: 0 when the
     *  spread is disabled, ceil(cascades / budget) - 1 otherwise. */
    maxLagFrames(): number;
}

/** Create the scheduler for `cascadeCount` cascades and a per-frame budget of `cascadesPerFrame`
 *  static re-renders. A budget of 0 (or one that covers every cascade) disables the spread: every
 *  refit re-renders all cascades in its own frame, the historical behaviour. */
export function createCsmStaticRefitScheduler(cascadeCount: number, cascadesPerFrame: number): CsmStaticRefitScheduler {
    const count = Math.max(0, Math.floor(cascadeCount));
    const budget = Number.isFinite(cascadesPerFrame) && cascadesPerFrame > 0 && cascadesPerFrame < count ? Math.floor(cascadesPerFrame) : 0;
    const waiting: boolean[] = new Array<boolean>(count).fill(false);
    let waitingCount = 0;
    let immediate = false;
    let cursor = 0;
    return {
        arm(spread: boolean): void {
            waiting.fill(true);
            waitingCount = count;
            immediate = budget === 0 || !spread;
        },
        pending(): boolean {
            return waitingCount > 0;
        },
        take(): number[] {
            const out: number[] = [];
            if (waitingCount === 0) {
                return out;
            }
            const limit = immediate ? count : budget;
            for (let step = 0; step < count && out.length < limit; step++) {
                const cascade = (cursor + step) % count;
                if (waiting[cascade]) {
                    waiting[cascade] = false;
                    waitingCount--;
                    out.push(cascade);
                }
            }
            if (out.length > 0) {
                cursor = (out[out.length - 1]! + 1) % count;
            }
            if (waitingCount === 0) {
                immediate = false;
            }
            return out;
        },
        maxLagFrames(): number {
            return budget === 0 ? 0 : Math.ceil(count / budget) - 1;
        },
    };
}
