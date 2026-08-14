/** Babylon.js-compatible GUID helpers (`@babylonjs/core` `Misc/guid`). */

/**
 * Generate a pseudo-random RFC4122 v4 UUID, matching Babylon.js `RandomGUID`.
 * Be aware `Math.random()` could cause collisions, but all except 6 of the 128 bits are
 * randomly generated, so any two ids have a 1 in 2^122 chance of colliding.
 * @returns a pseudo random id
 */
export function RandomGUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Namespace-like object used to manipulate GUIDs, matching Babylon.js `GUID`.
 * Babylon.js declares `GUID` as a `const` object literal rather than a class, so the
 * compat layer mirrors that shape: consumers call `GUID.RandomId()` without `new`.
 */
export const GUID = {
    /**
     * Generate a pseudo-random RFC4122 v4 UUID. Alias of {@link RandomGUID}.
     * @returns a pseudo random id
     */
    RandomId: RandomGUID,
};
