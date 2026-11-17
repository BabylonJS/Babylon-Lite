/** @internal Split a dotted property path, or return `null` when a segment could reach an object prototype. */
export function splitSafePropertyPath(path: string): string[] | null {
    const parts = path.split(".");
    return parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype") ? null : parts;
}
