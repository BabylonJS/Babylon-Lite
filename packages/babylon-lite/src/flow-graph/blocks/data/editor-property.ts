import type { FgValue } from "../../types.js";

const UNSAFE_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

function propertyPath(propertyName: unknown): string[] | null {
    if (typeof propertyName !== "string" || propertyName.length === 0) {
        return null;
    }
    const path = propertyName.split(".");
    return path.every((part) => part.length > 0 && !UNSAFE_PROPERTIES.has(part)) ? path : null;
}

function propertyObject(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function getEditorProperty(object: unknown, propertyName: unknown): { valid: boolean; value: FgValue } {
    const path = propertyPath(propertyName);
    let current: unknown = object;
    if (!path) {
        return { valid: false, value: null };
    }
    try {
        for (const part of path) {
            const owner = propertyObject(current);
            if (!owner) {
                return { valid: false, value: null };
            }
            current = Reflect.get(owner, part);
        }
    } catch {
        return { valid: false, value: null };
    }
    return { valid: true, value: (current ?? null) as FgValue };
}

export function setEditorProperty(object: unknown, propertyName: unknown, value: FgValue): boolean {
    const path = propertyPath(propertyName);
    let owner = propertyObject(object);
    if (!path || !owner) {
        return false;
    }
    try {
        for (const part of path.slice(0, -1)) {
            let child = propertyObject(Reflect.get(owner, part));
            if (!child) {
                child = {};
                if (!Reflect.set(owner, part, child)) {
                    return false;
                }
            }
            owner = child;
        }
        return Reflect.set(owner, path[path.length - 1]!, value);
    } catch {
        return false;
    }
}
