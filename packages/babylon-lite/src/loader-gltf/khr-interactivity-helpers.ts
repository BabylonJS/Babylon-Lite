export interface KhrInteractivityRuntimeValueSnapshot {
    runtimeValueFingerprint?: string;
    unrepresentable?: true;
}

export function hasDefaultInteractivityFlowInput(operation: string): boolean {
    return (
        operation !== "flow/waitAll" &&
        (operation.startsWith("flow/") ||
            operation.startsWith("animation/") ||
            operation === "pointer/set" ||
            operation === "pointer/interpolate" ||
            operation === "variable/set" ||
            operation === "variable/interpolate" ||
            operation === "event/send" ||
            operation === "event/stopPropagation" ||
            operation === "flow/log:BABYLON")
    );
}

function normalizeInteractivityEventValue(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (value !== null && typeof value === "object") {
        const arrayValue = (value as { asArray?: () => ArrayLike<unknown> }).asArray;
        if (typeof arrayValue === "function") {
            return Array.from(arrayValue.call(value));
        }
        if (Object.prototype.hasOwnProperty.call(value, "value")) {
            const nested = (value as { value: unknown }).value;
            return Array.isArray(nested) ? nested.slice() : [nested];
        }
    }
    return [value];
}

export function normalizeInteractivityEventDataConfiguration(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value
            .filter((entry): entry is { id: string; type?: unknown; value?: unknown } => entry !== null && typeof entry === "object" && typeof entry.id === "string")
            .map((entry) => ({
                id: entry.id,
                type: entry.type,
                ...(entry.value === undefined ? {} : { value: normalizeInteractivityEventValue(entry.value) }),
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
    }
    if (value !== null && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
            .map(([id, entry]) => {
                if (entry === null || typeof entry !== "object") {
                    return { id, malformed: true };
                }
                const definition = entry as { type?: string | { typeName?: string }; value?: unknown };
                return {
                    id,
                    type: typeof definition.type === "string" ? definition.type : definition.type?.typeName,
                    ...(definition.value === undefined ? {} : { value: normalizeInteractivityEventValue(definition.value) }),
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
    }
    return value;
}

export function normalizeKhrInteractivityRuntimeValue(value: unknown): unknown[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value !== null && typeof value === "object") {
        const arrayValue = (value as { asArray?: () => ArrayLike<unknown> }).asArray;
        if (typeof arrayValue === "function") {
            return Array.from(arrayValue.call(value));
        }
        if ("value" in value && typeof (value as { value?: unknown }).value !== "object") {
            return [(value as { value: unknown }).value];
        }
    }
    return Array.isArray(value) ? value.slice() : [value];
}

function encodeKhrInteractivityRuntimeValue(value: unknown, ancestors: Set<object>): unknown {
    if (value === undefined) {
        return ["undefined"];
    }
    if (value === null) {
        return ["null"];
    }
    if (typeof value === "boolean" || typeof value === "string") {
        return [typeof value, value];
    }
    if (typeof value === "number") {
        const encodedNumber = Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : Object.is(value, -0) ? "-0" : value;
        return ["number", encodedNumber];
    }
    if (typeof value !== "object" || Object.getOwnPropertySymbols(value).length !== 0 || ancestors.has(value)) {
        return undefined;
    }

    if (Array.isArray(value)) {
        const invalidProperty = Object.getOwnPropertyNames(value).some((key) => {
            if (key === "length") {
                return false;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !descriptor || !("value" in descriptor);
        });
        if (invalidProperty) {
            return undefined;
        }
    } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return undefined;
        }
        const invalidProperty = Object.getOwnPropertyNames(value).some((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return !Object.prototype.propertyIsEnumerable.call(value, key) || !descriptor || !("value" in descriptor);
        });
        if (invalidProperty) {
            return undefined;
        }
    }

    ancestors.add(value);
    const encoded = Array.isArray(value)
        ? value.map((entry) => encodeKhrInteractivityRuntimeValue(entry, ancestors))
        : Object.keys(value)
              .sort()
              .map((key) => [key, encodeKhrInteractivityRuntimeValue((value as Record<string, unknown>)[key], ancestors)]);
    ancestors.delete(value);
    if (encoded.some((entry) => (Array.isArray(value) ? entry === undefined : (entry as unknown[])[1] === undefined))) {
        return undefined;
    }
    return [Array.isArray(value) ? "array" : "object", encoded];
}

export function createKhrInteractivityRuntimeValueSnapshot(value: unknown): KhrInteractivityRuntimeValueSnapshot {
    try {
        const normalized = Array.isArray(value) ? value : normalizeKhrInteractivityRuntimeValue(value);
        const encoded = encodeKhrInteractivityRuntimeValue(normalized, new Set<object>());
        return encoded === undefined ? { unrepresentable: true } : { runtimeValueFingerprint: JSON.stringify(encoded) };
    } catch {
        return { unrepresentable: true };
    }
}
