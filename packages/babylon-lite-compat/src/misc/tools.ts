/** Babylon.js-compatible `Tools` helpers (the small, pure subset). */

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
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    },
};
