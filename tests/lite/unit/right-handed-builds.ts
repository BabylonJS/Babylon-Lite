/**
 * Dual-build harness for the right-handed pair tests: load the same engine modules once per `#coordinate-system`
 * variant, so one test feeds both builds the same input and compares the results. Usable from any test file,
 * including one whose `vi.mock` fixtures stand in for the GPU (hoisted mocks survive `vi.resetModules`).
 */
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

/** Absolute engine source root (forward slashes): `import(\`${SRC}xr/xr-pointer\`)` inside a build. */
export const SRC = fileURLToPath(new URL("../../../packages/babylon-lite/src/", import.meta.url)).replace(/\\/g, "/");

const SEAM = `${SRC}engine/coordinate-system`;

/** Load engine modules in one handedness; `load` must use dynamic `import()` so the variant applies. */
export async function inBuild<T>(rightHanded: boolean, load: (rightHanded: boolean) => Promise<T>): Promise<T> {
    vi.resetModules();
    if (rightHanded) {
        vi.doMock(SEAM, () => import(`${SEAM}-rh`));
    } else {
        vi.doUnmock(SEAM);
    }
    return load(rightHanded);
}

/** The same input through both builds: `[leftHanded, rightHanded]`. */
export async function bothBuilds<T>(run: (rightHanded: boolean) => Promise<T>): Promise<[T, T]> {
    return [await inBuild(false, run), await inBuild(true, run)];
}

/** Restore the default (left-handed) build; call from `afterEach`. */
export function resetBuild(): void {
    vi.doUnmock(SEAM);
    vi.resetModules();
}

/** Element-wise `toBeCloseTo`, with a readable length check first. */
export function closeTo(actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 6): boolean {
    if (actual.length !== expected.length) {
        return false;
    }
    for (let i = 0; i < actual.length; i++) {
        if (!(Math.abs(actual[i]! - expected[i]!) < 10 ** -digits / 2)) {
            return false;
        }
    }
    return true;
}

/** `S·m·S` for a 4×4 storage matrix and the mirror `S = diag(sx, sy, sz, 1)`: the same transform seen in the mirrored world. */
export function mirrorMat4(m: ArrayLike<number>, axis: 0 | 1 | 2): number[] {
    return Array.from(m, (value, i) => ((Math.floor(i / 4) === axis) !== (i % 4 === axis) ? -value : value));
}
