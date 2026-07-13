/**
 * redact-secrets.ts — Scrub BrowserStack credentials from test artifacts.
 *
 * The parity-cloud Playwright config connects over a CDP wsEndpoint that embeds
 * BROWSERSTACK_ACCESS_KEY (and username). On failures, Playwright can echo that
 * endpoint into the JUnit XML and HTML report that the ParityCloud job publishes
 * and uploads — which would leak the access key in build artifacts. This script
 * walks the given paths and replaces every occurrence of the credentials (both
 * raw and URL-encoded, since the wsEndpoint is URL-encoded) with "***".
 *
 * Usage:
 *   tsx scripts/redact-secrets.ts <path> [<path> ...]
 *
 * No-op when BROWSERSTACK_ACCESS_KEY / BROWSERSTACK_USERNAME are unset, or when a
 * path does not exist (so it is always safe to run with `condition: always()`).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

// Only scrub text-based report artifacts; skip binaries (screenshots, traces).
const TEXT_EXTENSIONS = new Set([".xml", ".html", ".htm", ".json", ".txt", ".log", ".js", ".md", ".css"]);

function collectSecrets(): string[] {
    const secrets: string[] = [];
    for (const name of ["BROWSERSTACK_ACCESS_KEY", "BROWSERSTACK_USERNAME"]) {
        const value = process.env[name];
        if (value && value.length >= 4) {
            secrets.push(value);
            const encoded = encodeURIComponent(value);
            if (encoded !== value) {
                secrets.push(encoded);
            }
        }
    }
    // De-dupe and sort longest-first so overlapping values are fully masked.
    return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactFile(filePath: string, patterns: RegExp[]): void {
    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch {
        return; // unreadable / binary — skip
    }
    let redacted = content;
    for (const pattern of patterns) {
        redacted = redacted.replace(pattern, "***");
    }
    if (redacted !== content) {
        writeFileSync(filePath, redacted);
        console.log(`[redact-secrets] Redacted ${filePath}`);
    }
}

function walk(target: string, patterns: RegExp[]): void {
    let stats;
    try {
        stats = statSync(target);
    } catch {
        return; // path does not exist — safe no-op
    }
    if (stats.isDirectory()) {
        for (const entry of readdirSync(target)) {
            walk(join(target, entry), patterns);
        }
        return;
    }
    const dot = target.lastIndexOf(".");
    const ext = dot >= 0 ? target.slice(dot).toLowerCase() : "";
    if (TEXT_EXTENSIONS.has(ext)) {
        redactFile(target, patterns);
    }
}

function main(): void {
    const paths = process.argv.slice(2);
    if (paths.length === 0) {
        console.error("[redact-secrets] Usage: tsx scripts/redact-secrets.ts <path> [<path> ...]");
        process.exit(1);
    }
    const secrets = collectSecrets();
    if (secrets.length === 0) {
        console.log("[redact-secrets] No BrowserStack credentials in env — nothing to redact.");
        return;
    }
    const patterns = secrets.map((s) => new RegExp(escapeRegExp(s), "g"));
    for (const p of paths) {
        walk(p, patterns);
    }
    console.log("[redact-secrets] Done.");
}

main();
