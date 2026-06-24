// Embeddable mode for the Lite playground.
//
// A host page (e.g. the classic Babylon playground, docs, or a blog) can embed
// the playground in an iframe with `?embed=runner` (canvas + console only) or
// `?embed=split` (compact editor + canvas). The two sides talk over a namespaced
// `postMessage` protocol so the host can drive the playground and observe output.
//
// All messages carry `channel: "babylon-lite-playground"` so they never collide
// with the internal runner-iframe protocol or unrelated host traffic.

import { snippetPath } from "./snippets";

export const EMBED_CHANNEL = "babylon-lite-playground";

export type EmbedMode = "runner" | "split";

/**
 * Validate a host-supplied `embedOrigin`. `postMessage` throws if the targetOrigin
 * isn't `"*"`/`"/"` or a valid absolute origin, so an invalid value (e.g.
 * `?embedOrigin=foo`) would break all embed messaging — fall back to `"*"` instead.
 */
function sanitizeTargetOrigin(value: string | null): string {
    if (!value || value === "*" || value === "/") {
        return "*";
    }
    try {
        // A well-formed origin round-trips through URL with an identical `.origin`.
        return new URL(value).origin === value ? value : "*";
    } catch {
        return "*";
    }
}

/** Messages the host sends to the embedded playground. */
export type EmbedInboundMessage =
    | { channel: typeof EMBED_CHANNEL; type: "loadCode"; code: string; run?: boolean }
    | { channel: typeof EMBED_CHANNEL; type: "run" }
    | { channel: typeof EMBED_CHANNEL; type: "dispose" }
    | { channel: typeof EMBED_CHANNEL; type: "getCode" };

/** Messages the embedded playground sends to the host. */
export type EmbedOutboundMessage =
    | { channel: typeof EMBED_CHANNEL; type: "ready"; mode: EmbedMode }
    | { channel: typeof EMBED_CHANNEL; type: "console"; level: "log" | "info" | "warn" | "error" | "system"; text: string }
    | { channel: typeof EMBED_CHANNEL; type: "error"; text: string }
    | { channel: typeof EMBED_CHANNEL; type: "stats"; fps: number }
    | { channel: typeof EMBED_CHANNEL; type: "ran" }
    | { channel: typeof EMBED_CHANNEL; type: "code"; code: string };

export interface EmbedHandlers {
    loadCode(code: string, run: boolean): void;
    run(): void;
    dispose(): void;
    getCode(): string;
}

/**
 * Resolve the embed mode from a URL query string. `?embed`, `?embed=1`,
 * `?embed=true` and `?embed=split` select the compact split view; `?embed=runner`
 * selects the runner-only view. Returns `null` when not embedded.
 */
export function getEmbedMode(search: string): EmbedMode | null {
    const params = new URLSearchParams(search);
    if (!params.has("embed")) {
        return null;
    }
    const value = (params.get("embed") ?? "").toLowerCase();
    return value === "runner" ? "runner" : "split";
}

/**
 * Bridges the embedded playground to its host window. Inbound messages from the
 * parent invoke the supplied handlers; `emit` posts events back to the parent.
 *
 * A host can restrict accepted/targeted origins with `?embedOrigin=<origin>`;
 * otherwise messages are accepted from the parent and emitted with `"*"`.
 */
export class EmbedHost {
    private readonly handlers: EmbedHandlers;
    private readonly mode: EmbedMode;
    private readonly targetOrigin: string;

    constructor(mode: EmbedMode, handlers: EmbedHandlers, search: string = location.search) {
        this.mode = mode;
        this.handlers = handlers;
        this.targetOrigin = sanitizeTargetOrigin(new URLSearchParams(search).get("embedOrigin"));
        window.addEventListener("message", this.handleMessage);
    }

    /** Announce readiness to the host. Call once the playground is wired up. */
    ready(): void {
        this.emit({ channel: EMBED_CHANNEL, type: "ready", mode: this.mode });
    }

    emit(message: EmbedOutboundMessage): void {
        if (window.parent === window) {
            return;
        }
        window.parent.postMessage(message, this.targetOrigin);
    }

    private handleMessage = (event: MessageEvent): void => {
        // Only honour messages from the embedding parent (not the runner iframe).
        if (event.source !== window.parent) {
            return;
        }
        if (this.targetOrigin !== "*" && event.origin !== this.targetOrigin) {
            return;
        }
        const message = event.data as EmbedInboundMessage | undefined;
        if (!message || message.channel !== EMBED_CHANNEL) {
            return;
        }
        switch (message.type) {
            case "loadCode":
                this.handlers.loadCode(message.code, message.run ?? false);
                break;
            case "run":
                this.handlers.run();
                break;
            case "dispose":
                this.handlers.dispose();
                break;
            case "getCode":
                this.emit({ channel: EMBED_CHANNEL, type: "code", code: this.handlers.getCode() });
                break;
            default:
                break;
        }
    };
}

const CODE_HASH_PREFIX = "code=";

/** Base64url-encode UTF-8 source for carrying code in a URL fragment. */
export function encodeCodeHash(code: string): string {
    const bytes = new TextEncoder().encode(code);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a `#code=` fragment back to source, or `null` if the hash isn't one. */
export function decodeCodeHash(hash: string): string | null {
    const trimmed = hash.replace(/^#/, "");
    if (!trimmed.startsWith(CODE_HASH_PREFIX)) {
        return null;
    }
    const b64 = trimmed.slice(CODE_HASH_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    try {
        const binary = atob(b64);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Build a deep link that opens the full standalone playground (no embed) with the
 * given content. A saved snippet uses the path form `/snippet/ID/v/VERSION`;
 * otherwise the whole project is carried inline as JSON in a `#code=` fragment
 * (legacy single-file links carry plain source). {@link decodeCodeHash} returns
 * that JSON string for the caller to interpret.
 */
export function openInPlaygroundUrl(payload: string, snippet: { id: string; version: string } | null): string {
    if (snippet) {
        return `${location.origin}${snippetPath(snippet.id, snippet.version)}`;
    }
    return `${location.origin}/#${CODE_HASH_PREFIX}${encodeCodeHash(payload)}`;
}
