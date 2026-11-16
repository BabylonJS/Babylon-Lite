/** Babylon.js-compatible `Tools` helpers (the small, pure subset). */

import { RandomGUID } from "./guid.js";
import { PrecisionDate } from "./misc-utils.js";

export const Tools = {
    /** Current high-resolution timestamp in milliseconds, matching Babylon.js's numeric property. */
    get Now(): number {
        return PrecisionDate.Now;
    },

    ToRadians(degrees: number): number {
        return (degrees * Math.PI) / 180;
    },

    ToDegrees(radians: number): number {
        return (radians * 180) / Math.PI;
    },

    /** Clamp `value` into the inclusive `[min, max]` range. */
    Clamp(value: number, min = 0, max = 1): number {
        return Math.min(max, Math.max(min, value));
    },

    /** Generate an RFC4122 v4 UUID (used by Babylon.js for unique ids). */
    RandomId(): string {
        return RandomGUID();
    },
};
