const UNIFORM_BUFFER_BYTES = 64 * 1024;

/** @internal Maximum supported probes stored in one voxel. */
export const _PBR_LOCAL_ENVIRONMENT_CANDIDATE_CAPACITY = 12;
/** @internal Probe count and flags occupy one vec4 before the probe records. */
export const _PBR_LOCAL_ENVIRONMENT_HEADER_U32 = 4;
/** @internal Seven vec4 values per probe. */
export const _PBR_LOCAL_ENVIRONMENT_PROBE_FLOATS = 28;
/** @internal Full 64 KiB UBO size expressed as floats. */
export const _PBR_LOCAL_ENVIRONMENT_UNIFORM_FLOATS = UNIFORM_BUFFER_BYTES / 4;
/** @internal Header flag enabling oriented box projection. */
export const _PBR_LOCAL_ENVIRONMENT_PARALLAX_FLAG = 1;
/** @internal Header flag replacing probe samples and final PBR output with debug colors. */
export const _PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG = 2;
/** @internal Per-probe metadata bit selecting spherical projection and influence. */
export const _PBR_LOCAL_ENVIRONMENT_SPHERE_FLAG = 1 << 24;

/** Maximum probe records that fit in the WebGPU-guaranteed 64 KiB uniform binding. */
export const MAX_PBR_LOCAL_ENVIRONMENT_PROBES = Math.floor((_PBR_LOCAL_ENVIRONMENT_UNIFORM_FLOATS - _PBR_LOCAL_ENVIRONMENT_HEADER_U32) / _PBR_LOCAL_ENVIRONMENT_PROBE_FLOATS);

/** Maximum probes evaluated per fragment. Defaults to four and is fixed during initialization. */
export let MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES = 4;

let _initialized = false;

/** @internal Lock the per-voxel shader probe count before registering the extension. */
export function _initializePbrLocalCubemapLimits(maxCandidates: number | undefined): void {
    if (_initialized) {
        if (maxCandidates !== undefined && maxCandidates !== MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES) {
            throw new Error(`[babylon-lite] local cubemap maxCandidates is already ${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES} and cannot be changed after initialization`);
        }
        return;
    }

    const value = maxCandidates ?? MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES;
    if (!Number.isInteger(value) || value < 1 || value > _PBR_LOCAL_ENVIRONMENT_CANDIDATE_CAPACITY) {
        throw new Error(`[babylon-lite] local cubemap maxCandidates must be an integer from 1 to ${_PBR_LOCAL_ENVIRONMENT_CANDIDATE_CAPACITY}`);
    }
    MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES = value;
    _initialized = true;
}
