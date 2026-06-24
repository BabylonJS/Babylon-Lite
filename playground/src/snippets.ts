// Snippet save/share client for the Babylon snippet server (snippet.babylonjs.com).
//
// Snippets are stored using the same V2 manifest envelope the classic Babylon
// playground uses, so the format is forward-compatible (multi-file, version
// pinning via `imports`/`cdnBase`) and interoperable with the classic loader. A
// `kind: "babylon-lite"` marker tags snippets as Lite so we can reject snippets
// authored for the classic engine when loading.

const SNIPPET_SERVER_BASE = "https://snippet.babylonjs.com";

// The snippet server requires `application/json` to persist the payload, but its
// CORS preflight only succeeds for an allow-list of babylonjs.com origins — a
// browser POST from any other origin (e.g. localhost) is blocked. In dev we
// therefore route through a same-origin `/snippet-api` path that Vite proxies
// server-side (no browser CORS). `/snippet-api` (not `/snippet`) keeps the
// `/snippet/ID/v/VERSION` app routes free for SPA navigation. In production the
// playground must be served from an allow-listed origin (or front a same-origin
// proxy at deploy time).
const SNIPPET_SERVER_URL = import.meta.env.DEV ? "/snippet-api" : SNIPPET_SERVER_BASE;
const ENGINE_TAG = "WebGPU-Lite";
const MANIFEST_VERSION = 2;
const LITE_KIND = "babylon-lite";
const ENTRY_FILE = "index.ts";

/** A multi-file playground project: a flat map of files plus the bundle entry. */
export interface Project {
    files: Record<string, string>;
    entry: string;
}

export interface SnippetMeta {
    name?: string;
    description?: string;
    tags?: string;
}

export interface SavedSnippet {
    /** Base snippet id, e.g. `"XKIIYQ"`. */
    id: string;
    /** Revision number as a string, e.g. `"0"` or `"3"`. */
    version: string;
    /** Shareable id including the revision when non-zero, e.g. `"XKIIYQ#3"`. */
    snippetId: string;
}

export interface LoadedSnippet {
    files: Record<string, string>;
    entry: string;
    name: string;
    description: string;
    tags: string;
}

interface V2Manifest {
    v: number;
    language: "TS" | "JS";
    entry: string;
    imports: Record<string, string>;
    files: Record<string, string>;
    kind?: string;
}

interface InnerPayload {
    code?: string;
    unicode?: string;
    engine?: string;
    version?: number;
}

interface SnippetEnvelope {
    id?: string;
    version?: number | string;
    jsonPayload?: string;
    payload?: string;
    name?: string;
    description?: string;
    tags?: string;
}

/**
 * Base64-encode a string via UTF-8, returning `undefined` when the round-trip
 * through Latin-1 is lossless (i.e. encoding is unnecessary). Mirrors the
 * classic playground so non-ASCII snippets survive the server round-trip.
 */
function encodeUnicode(source: string): string | undefined {
    const bytes = new TextEncoder().encode(source);
    let latin1 = "";
    for (let i = 0; i < bytes.length; i++) {
        latin1 += String.fromCharCode(bytes[i]!);
    }
    return latin1 === source ? undefined : btoa(latin1);
}

/** Decode a UTF-8 Base64 string produced by {@link encodeUnicode}. */
function decodeUnicode(encoded: string): string {
    const latin1 = atob(encoded);
    const bytes = new Uint8Array(latin1.length);
    for (let i = 0; i < latin1.length; i++) {
        bytes[i] = latin1.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

/** Strip the `#revision` suffix from a snippet id for the POST URL. */
function baseSnippetId(snippetId: string): string {
    const hash = snippetId.indexOf("#");
    return hash >= 0 ? snippetId.slice(0, hash) : snippetId;
}

/**
 * Save a project to the snippet server. Pass `existingId` to create a new
 * revision of an already-saved snippet; omit it to create a brand-new snippet.
 * All files are persisted in the V2 manifest's `files` map.
 */
export async function saveSnippet(project: Project, meta: SnippetMeta = {}, existingId?: string): Promise<SavedSnippet> {
    const entry = project.files[project.entry] !== undefined ? project.entry : (Object.keys(project.files)[0] ?? ENTRY_FILE);
    const manifest: V2Manifest = {
        v: MANIFEST_VERSION,
        language: "TS",
        entry,
        imports: {},
        files: { ...project.files },
        kind: LITE_KIND,
    };
    const manifestJson = JSON.stringify(manifest);
    const innerPayload = JSON.stringify({
        code: manifestJson,
        unicode: encodeUnicode(manifestJson),
        engine: ENGINE_TAG,
        version: MANIFEST_VERSION,
    } satisfies InnerPayload);
    const body = JSON.stringify({
        payload: innerPayload,
        name: meta.name ?? "",
        description: meta.description ?? "",
        tags: meta.tags ?? "",
    });

    const baseId = existingId ? baseSnippetId(existingId) : "";
    const url = baseId ? `${SNIPPET_SERVER_URL}/${baseId}` : SNIPPET_SERVER_URL;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    if (!response.ok) {
        throw new Error(`Failed to save snippet: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as SnippetEnvelope;
    const id = String(result.id ?? "");
    const version = String(result.version ?? "0");
    const snippetId = version && version !== "0" ? `${id}#${version}` : id;
    return { id, version, snippetId };
}

/**
 * Load a snippet by id (optionally `id#revision`). Throws if the snippet was not
 * authored with the Babylon Lite playground.
 */
export async function loadSnippet(snippetId: string): Promise<LoadedSnippet> {
    let path = snippetId.replace(/#/g, "/");
    if (!path.includes("/")) {
        path += "/0";
    }
    const response = await fetch(`${SNIPPET_SERVER_URL}/${path}`);
    if (!response.ok) {
        throw new Error(`Failed to load snippet "${snippetId}": ${response.status} ${response.statusText}`);
    }

    const envelope = (await response.json()) as SnippetEnvelope;
    const rawPayload = envelope.jsonPayload ?? envelope.payload;
    if (!rawPayload) {
        throw new Error("Snippet payload is empty.");
    }

    const payload = JSON.parse(rawPayload) as InnerPayload;
    // `code` holds the manifest JSON; `unicode` is a UTF-8-safe Base64 fallback.
    const manifestJson = payload.unicode ? decodeUnicode(payload.unicode) : (payload.code ?? "");

    let files: Record<string, string> = { [ENTRY_FILE]: manifestJson };
    let entry = ENTRY_FILE;
    try {
        const manifest = JSON.parse(manifestJson) as V2Manifest;
        if (manifest && manifest.files && typeof manifest.files === "object") {
            if (manifest.kind && manifest.kind !== LITE_KIND) {
                throw new Error("This snippet was not created with the Babylon Lite playground.");
            }
            files = manifest.files;
            entry = manifest.files[manifest.entry] !== undefined ? manifest.entry : (Object.keys(manifest.files)[0] ?? ENTRY_FILE);
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes("Babylon Lite")) {
            throw err;
        }
        // Otherwise `manifestJson` was raw (legacy) code — use it verbatim as the entry file.
    }

    return {
        files,
        entry,
        name: envelope.name ?? "",
        description: envelope.description ?? "",
        tags: envelope.tags ?? "",
    };
}

/** Build the shareable playground permalink for a snippet revision. */
export function permalinkFor(id: string, version: string): string {
    return `${location.origin}${snippetPath(id, version)}`;
}

/** The path-based URL for a snippet revision, e.g. `/snippet/XKIIYQ/v/0`. */
export function snippetPath(id: string, version: string): string {
    return `/snippet/${id}/v/${version}`;
}

/** Parse a `/snippet/ID/v/VERSION` pathname, or `null` when it isn't one. */
export function parseSnippetPath(pathname: string): { id: string; version: string } | null {
    const match = pathname.match(/^\/snippet\/([^/]+)\/v\/([^/]+)\/?$/);
    return match ? { id: match[1]!, version: match[2]! } : null;
}

/** Split a combined snippet id (`"XKIIYQ"` or `"XKIIYQ#3"`) into id + revision. */
export function splitSnippetId(snippetId: string): { id: string; version: string } {
    const hash = snippetId.indexOf("#");
    return hash >= 0 ? { id: snippetId.slice(0, hash), version: snippetId.slice(hash + 1) } : { id: snippetId, version: "0" };
}

/** Combine an id and revision into the snippet-server lookup id (rev 0 omitted). */
export function combineSnippetId(id: string, version: string): string {
    return version && version !== "0" ? `${id}#${version}` : id;
}

/** Parse the snippet id from a URL hash (e.g. `"#XKIIYQ#3"` → `"XKIIYQ#3"`). */
export function snippetIdFromHash(hash: string): string | null {
    const trimmed = hash.replace(/^#/, "").trim();
    return trimmed.length ? trimmed : null;
}
