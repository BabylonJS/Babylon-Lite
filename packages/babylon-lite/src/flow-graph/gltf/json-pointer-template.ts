export interface JsonPointerTemplateParameter {
    readonly id: string;
    readonly kind: "integer" | "reference";
}

interface JsonPointerTemplateSegment {
    readonly literal?: string;
    readonly parameter?: JsonPointerTemplateParameter;
}

export interface ParsedJsonPointerTemplate {
    readonly segments: readonly JsonPointerTemplateSegment[];
    readonly parameters: readonly JsonPointerTemplateParameter[];
}

function decodeSegment(segment: string): string {
    if (/~(?:[^01]|$)/.test(segment)) {
        throw new Error(`invalid RFC 6901 escape in pointer segment ${JSON.stringify(segment)}`);
    }
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function encodeSegment(segment: string): string {
    return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function collapseLiteralBrackets(segment: string): string {
    for (const bracket of ["[", "]", "{", "}"]) {
        const runs = segment.match(new RegExp(`\\${bracket}+`, "g")) ?? [];
        if (runs.some((run) => run.length % 2 !== 0)) {
            throw new Error(`literal pointer brackets must be doubled in ${JSON.stringify(segment)}`);
        }
    }
    return segment.replace(/\[\[/g, "[").replace(/\]\]/g, "]").replace(/\{\{/g, "{").replace(/\}\}/g, "}");
}

function parameterId(segment: string, open: string, close: string): string | null {
    if (!segment.startsWith(open) || !segment.endsWith(close)) {
        return null;
    }
    const id = segment.slice(1, -1);
    return id && !["[", "]", "{", "}"].some((bracket) => id.includes(bracket)) ? id : null;
}

/** Parse and validate the KHR_interactivity JSON Pointer Template grammar. */
export function parseJsonPointerTemplate(template: string): ParsedJsonPointerTemplate {
    if (!template.startsWith("/")) {
        throw new Error("JSON Pointer Templates must be absolute");
    }
    const parameters: JsonPointerTemplateParameter[] = [];
    const ids = new Set<string>();
    const segments = template
        .slice(1)
        .split("/")
        .map((encoded): JsonPointerTemplateSegment => {
            const decoded = decodeSegment(encoded);
            const integer = parameterId(decoded, "[", "]");
            const reference = parameterId(decoded, "{", "}");
            const id = integer ?? reference;
            if (!id) {
                return { literal: encodeSegment(collapseLiteralBrackets(decoded)) };
            }
            if (ids.has(id)) {
                throw new Error(`duplicate pointer parameter ${JSON.stringify(id)}`);
            }
            ids.add(id);
            const parameter: JsonPointerTemplateParameter = { id, kind: integer !== null ? "integer" : "reference" };
            parameters.push(parameter);
            return { parameter };
        });
    return { segments, parameters };
}

/** Substitute validated template parameters. Returning null indicates an invalid
 * runtime value (negative integer, null/unknown ref, or wrong value kind). */
export function substituteJsonPointerTemplate(parsed: ParsedJsonPointerTemplate, valueFor: (parameter: JsonPointerTemplateParameter) => unknown): string | null {
    const segments: string[] = [];
    for (const segment of parsed.segments) {
        if (segment.literal !== undefined) {
            segments.push(segment.literal);
            continue;
        }
        const parameter = segment.parameter!;
        const value = valueFor(parameter);
        if (parameter.kind === "reference" && typeof value === "string") {
            const match = /(\d+)\/?$/.exec(value);
            if (match) {
                segments.push(match[1]!);
                continue;
            }
        }
        const integer = typeof value === "number" ? value : typeof value === "object" && value && "value" in value ? value.value : NaN;
        if (typeof integer === "number" && Number.isInteger(integer) && integer >= 0) {
            // Numeric `{parameter}` values preserve compatibility with earlier drafts.
            segments.push(String(integer));
            continue;
        }
        return null;
    }
    return `/${segments.join("/")}`;
}
