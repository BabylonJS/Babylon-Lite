/** Babylon.js-compatible `Tools` helpers (the small, pure subset). */

import { RandomGUID } from "./guid.js";

export const Tools = {
    /** High-resolution timestamp in milliseconds. */
    Now(): number {
        return typeof performance !== "undefined" ? performance.now() : Date.now();
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
