/**
 * Helpers used only on right-handed branches (see `coordinate-system.ts`). Call them only inside
 * `if (_rightHanded !== null) { … }`: tree-shaking drops an import used there in a left-handed build,
 * but keeps one referenced from an expression such as `_rightHanded && f(x)`, which only the
 * minifier removes, too late to drop the helper.
 */

import type { Mat4, Mat4Storage } from "../math/types.js";

/** @internal Turn a left-handed look-at camera world matrix into Babylon's right-handed one, in place.
 *  Right-handed cameras look down their local -Z with +X to the right: `W_RH = W_LH·diag(-1, 1, -1)`,
 *  i.e. the X and Z basis columns are negated and the position is untouched. */
export function _toRightHandedCameraWorld(m: Mat4): void {
    const s = m as unknown as Mat4Storage;
    for (const i of [0, 1, 2, 8, 9, 10]) {
        s[i] = -s[i]!;
    }
}
