/**
 * Sanitizes and verifies BrowserStack test artifacts before publication.
 *
 * Every file is inspected as bytes, and ZIP files (including nested ZIPs such
 * as Playwright trace.zip files) are unpacked in memory, sanitized, and rebuilt.
 * Unsupported archives, unreadable paths, symbolic links, missing credentials,
 * and residual raw or URL-encoded credentials fail closed.
 *
 * Usage:
 *   tsx scripts/redact-secrets.ts sanitize <path> [<path> ...]
 *   tsx scripts/redact-secrets.ts verify <path> [<path> ...]
 */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { pathToFileURL } from "url";
import { unzipSync, zipSync } from "fflate";

const MASK_BYTE = "*".charCodeAt(0);
const MAX_ARCHIVE_DEPTH = 8;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const UNSUPPORTED_ARCHIVE_EXTENSIONS = [".7z", ".br", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz"];

export interface BrowserStackCredentials {
    username: string;
    accessKey: string;
}

export interface ArtifactSecurityStats {
    filesInspected: number;
    archivesInspected: number;
    redactions: number;
}

type Mode = "sanitize" | "verify";

interface ProcessResult {
    data: Buffer;
    changed: boolean;
}

interface ArchiveBudget {
    entriesRemaining: number;
    bytesRemaining: number;
}

class ArtifactSecurityError extends Error {}

function encodedVariants(value: string): string[] {
    const variants = new Set<string>([value]);
    let encoded = value;
    for (let depth = 0; depth < 3; depth++) {
        encoded = encodeURIComponent(encoded);
        variants.add(encoded);
        variants.add(encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()));
    }
    variants.add(new URLSearchParams({ value }).toString().slice("value=".length));
    return [...variants];
}

function credentialVariants(credentials: BrowserStackCredentials): string[] {
    if (!credentials.username || !credentials.accessKey || credentials.username === "$(BROWSERSTACK_USERNAME)" || credentials.accessKey === "$(BROWSERSTACK_ACCESS_KEY)") {
        throw new ArtifactSecurityError("Required BrowserStack credentials are unavailable; artifacts cannot be declared safe.");
    }
    return [...new Set([...encodedVariants(credentials.accessKey), ...encodedVariants(credentials.username)])].sort((a, b) => b.length - a.length);
}

export function browserStackCredentialsFromEnvironment(env: NodeJS.ProcessEnv = process.env): BrowserStackCredentials {
    return {
        username: env.BROWSERSTACK_USERNAME ?? "",
        accessKey: env.BROWSERSTACK_ACCESS_KEY ?? "",
    };
}

function replaceAllBytes(input: Buffer, patterns: readonly Buffer[]): { data: Buffer; replacements: number } {
    let output = input;
    let replacements = 0;

    for (const pattern of patterns) {
        let offset = 0;
        while (offset <= output.length - pattern.length) {
            const index = output.indexOf(pattern, offset);
            if (index === -1) {
                break;
            }
            if (output === input) {
                output = Buffer.from(input);
            }
            output.fill(MASK_BYTE, index, index + pattern.length);
            replacements++;
            offset = index + pattern.length;
        }
    }

    return { data: output, replacements };
}

function containsCredential(input: Buffer, patterns: readonly Buffer[]): boolean {
    return patterns.some((pattern) => input.indexOf(pattern) !== -1);
}

function replaceAllText(input: string, variants: readonly string[]): { value: string; replacements: number } {
    let value = input;
    let replacements = 0;
    for (const variant of variants) {
        if (!value.includes(variant)) {
            continue;
        }
        const parts = value.split(variant);
        replacements += parts.length - 1;
        value = parts.join("*".repeat(variant.length));
    }
    return { value, replacements };
}

function isZip(data: Buffer, name: string): boolean {
    const signature = data.length >= 4 ? data.subarray(0, 4).toString("hex") : "";
    return name.toLowerCase().endsWith(".zip") || signature === "504b0304" || signature === "504b0506" || signature === "504b0708";
}

function isUnsupportedArchive(name: string): boolean {
    const lower = name.toLowerCase();
    return UNSUPPORTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function validateZipEntryName(name: string): void {
    const normalized = name.replace(/\\/g, "/");
    if (normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").includes("..")) {
        throw new ArtifactSecurityError("A compressed artifact contains an unsafe entry and cannot be published.");
    }
}

function processZip(
    input: Buffer,
    mode: Mode,
    bytePatterns: readonly Buffer[],
    textPatterns: readonly string[],
    stats: ArtifactSecurityStats,
    budget: ArchiveBudget,
    depth: number
): ProcessResult {
    if (depth > MAX_ARCHIVE_DEPTH) {
        throw new ArtifactSecurityError("A compressed artifact exceeds the supported nesting depth.");
    }

    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(input, {
            filter: (entry) => {
                if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || budget.entriesRemaining === 0 || entry.originalSize > budget.bytesRemaining) {
                    throw new ArtifactSecurityError("A compressed artifact exceeds the safe inspection budget.");
                }
                budget.entriesRemaining--;
                budget.bytesRemaining -= entry.originalSize;
                return true;
            },
        });
    } catch (error) {
        if (error instanceof ArtifactSecurityError) {
            throw error;
        }
        throw new ArtifactSecurityError("A compressed artifact could not be inspected.");
    }

    const names = Object.keys(entries);
    stats.archivesInspected++;
    const rebuilt: Record<string, Uint8Array> = {};
    for (const name of names) {
        validateZipEntryName(name);
        const sanitizedName = replaceAllText(name, textPatterns);
        if (mode === "verify" && sanitizedName.replacements > 0) {
            throw new ArtifactSecurityError("BrowserStack credentials remain in a publishable artifact.");
        }
        stats.redactions += sanitizedName.replacements;

        const entry = entries[name];
        if (!entry) {
            throw new ArtifactSecurityError("A compressed artifact entry could not be inspected.");
        }
        const processed = processBuffer(Buffer.from(entry), sanitizedName.value, mode, bytePatterns, textPatterns, stats, budget, depth);
        if (rebuilt[sanitizedName.value]) {
            throw new ArtifactSecurityError("Artifact sanitization produced conflicting archive entries.");
        }
        rebuilt[sanitizedName.value] = processed.data;
    }

    if (mode === "verify") {
        if (containsCredential(input, bytePatterns)) {
            throw new ArtifactSecurityError("BrowserStack credentials remain in a publishable artifact.");
        }
        return { data: input, changed: false };
    }

    try {
        return { data: Buffer.from(zipSync(rebuilt)), changed: true };
    } catch {
        throw new ArtifactSecurityError("A compressed artifact could not be rebuilt safely.");
    }
}

function processBuffer(
    input: Buffer,
    name: string,
    mode: Mode,
    bytePatterns: readonly Buffer[],
    textPatterns: readonly string[],
    stats: ArtifactSecurityStats,
    budget: ArchiveBudget,
    depth = 0
): ProcessResult {
    stats.filesInspected++;
    if (isZip(input, name)) {
        return processZip(input, mode, bytePatterns, textPatterns, stats, budget, depth + 1);
    }
    if (isUnsupportedArchive(name)) {
        throw new ArtifactSecurityError("A compressed artifact type is unsupported and cannot be published.");
    }

    if (mode === "verify") {
        if (containsCredential(input, bytePatterns)) {
            throw new ArtifactSecurityError("BrowserStack credentials remain in a publishable artifact.");
        }
        return { data: input, changed: false };
    }

    const result = replaceAllBytes(input, bytePatterns);
    stats.redactions += result.replacements;
    return { data: result.data, changed: result.replacements > 0 };
}

function processPath(
    target: string,
    mode: Mode,
    bytePatterns: readonly Buffer[],
    textPatterns: readonly string[],
    stats: ArtifactSecurityStats,
    budget: ArchiveBudget,
    renameTarget: boolean
): string {
    let metadata: ReturnType<typeof lstatSync>;
    try {
        metadata = lstatSync(target);
    } catch {
        throw new ArtifactSecurityError("A required artifact path could not be inspected.");
    }
    if (metadata.isSymbolicLink()) {
        throw new ArtifactSecurityError("Symbolic links are not allowed in publishable artifacts.");
    }

    if (metadata.isDirectory()) {
        let entries: string[];
        try {
            entries = readdirSync(target);
        } catch {
            throw new ArtifactSecurityError("An artifact directory could not be inspected.");
        }
        for (const entry of entries) {
            processPath(join(target, entry), mode, bytePatterns, textPatterns, stats, budget, true);
        }
    } else if (metadata.isFile()) {
        let data: Buffer;
        try {
            data = readFileSync(target);
        } catch {
            throw new ArtifactSecurityError("An artifact file could not be inspected.");
        }
        const processed = processBuffer(data, basename(target), mode, bytePatterns, textPatterns, stats, budget);
        if (mode === "sanitize" && processed.changed) {
            try {
                writeFileSync(target, processed.data);
            } catch {
                throw new ArtifactSecurityError("A sanitized artifact could not be written.");
            }
        }
    } else {
        throw new ArtifactSecurityError("A publishable artifact is not a regular file or directory.");
    }

    const sanitizedName = replaceAllText(basename(target), textPatterns);
    if (mode === "verify" && sanitizedName.replacements > 0) {
        throw new ArtifactSecurityError("BrowserStack credentials remain in a publishable artifact.");
    }
    stats.redactions += sanitizedName.replacements;
    if (mode === "sanitize" && renameTarget && sanitizedName.value !== basename(target)) {
        const renamed = join(dirname(target), sanitizedName.value);
        if (existsSync(renamed)) {
            throw new ArtifactSecurityError("Artifact sanitization produced conflicting file names.");
        }
        try {
            renameSync(target, renamed);
        } catch {
            throw new ArtifactSecurityError("A sanitized artifact could not be renamed safely.");
        }
        return renamed;
    }
    if (mode === "sanitize" && !renameTarget && sanitizedName.replacements > 0) {
        throw new ArtifactSecurityError("A requested artifact path contains a BrowserStack credential and cannot be renamed safely.");
    }
    return target;
}

function processArtifacts(paths: readonly string[], credentials: BrowserStackCredentials, mode: Mode): ArtifactSecurityStats {
    if (paths.length === 0) {
        throw new ArtifactSecurityError("At least one artifact path is required.");
    }

    const textPatterns = credentialVariants(credentials);
    const bytePatterns = textPatterns.map((pattern) => Buffer.from(pattern));
    const stats: ArtifactSecurityStats = { filesInspected: 0, archivesInspected: 0, redactions: 0 };
    const budget: ArchiveBudget = { entriesRemaining: MAX_ARCHIVE_ENTRIES, bytesRemaining: MAX_UNCOMPRESSED_ARCHIVE_BYTES };
    for (const artifactPath of paths) {
        processPath(artifactPath, mode, bytePatterns, textPatterns, stats, budget, false);
    }
    return stats;
}

export function sanitizeArtifacts(paths: readonly string[], credentials: BrowserStackCredentials): ArtifactSecurityStats {
    return processArtifacts(paths, credentials, "sanitize");
}

export function verifyArtifacts(paths: readonly string[], credentials: BrowserStackCredentials): ArtifactSecurityStats {
    return processArtifacts(paths, credentials, "verify");
}

function main(): void {
    const [mode, ...paths] = process.argv.slice(2);
    if (mode !== "sanitize" && mode !== "verify") {
        console.error("[artifact-security] Usage: tsx scripts/redact-secrets.ts <sanitize|verify> <path> [<path> ...]");
        process.exit(1);
    }

    try {
        const stats = processArtifacts(paths, browserStackCredentialsFromEnvironment(), mode);
        if (mode === "sanitize") {
            console.log(
                `[artifact-security] Sanitized ${stats.redactions} credential occurrence(s) across ${stats.filesInspected} file(s), including ${stats.archivesInspected} ZIP archive(s).`
            );
        } else {
            console.log(`[artifact-security] Verified ${stats.filesInspected} file(s), including ${stats.archivesInspected} ZIP archive(s).`);
        }
    } catch (error) {
        const message = error instanceof ArtifactSecurityError ? error.message : "Artifact security processing failed unexpectedly.";
        console.error(`[artifact-security] ${message}`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
