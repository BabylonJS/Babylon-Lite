/** Babylon.js-compatible GUID helpers (`@babylonjs/core` `Misc/guid`). */

/**
 * Generate a pseudo-random RFC4122 v4 UUID, matching Babylon.js `RandomGUID`.
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
 * Class used to manipulate GUIDs, matching Babylon.js `GUID`.
 */
export const GUID = {
    /**
     * Generate a pseudo-random RFC4122 v4 UUID.
     * @returns a pseudo random id
     */
    RandomId: RandomGUID,
};
