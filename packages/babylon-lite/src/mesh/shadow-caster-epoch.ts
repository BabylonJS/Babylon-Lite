/** Global revision for CPU-driven caster geometry/count changes that do not affect transforms. */
export let _shadowCasterEpoch = 0;

/** Mark cached static shadow maps and caster-bound fits dirty. */
export function bumpShadowCasterEpoch(): void {
    _shadowCasterEpoch = (_shadowCasterEpoch + 1) | 0;
}
