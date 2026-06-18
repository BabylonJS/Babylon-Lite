/**
 * Feature-comparison doc generator.
 *
 * Single source of truth: `lab/lite/docs/feature-comparison.html` (hand-authored
 * by whoever changes a feature's status). This script parses that table and
 * regenerates the per-category markdown tables in
 * `docs/lite/02-feature-comparison.md`, splicing them between the AUTOGEN markers.
 * The hand-written intro, legend, and trailing prose live OUTSIDE the markers and
 * are never touched.
 *
 * Mapping:
 *   - `<tr class="feat-cat"><td colspan="4">Name</td></tr>`  → `## Name` + a fresh table
 *   - `<tr class="feat-highlight">…</tr>`                    → feature prefixed with `★ `
 *   - `<tr>` with 4 `<td>`                                   → | Feature | Lite | BJS | Notes |
 *
 * Usage:
 *   tsx scripts/gen-feature-comparison.ts          # rewrite the doc in place
 *   tsx scripts/gen-feature-comparison.ts --check  # exit 1 if the doc is stale (no write)
 *
 * The lab HTML is a fragment (no <html> wrapper) injected into the lab UI, so we
 * parse only its <tbody>. The parser is dependency-free but strict: malformed
 * markup (a row without 4 cells, a missing <tbody>) throws loudly rather than
 * emitting a silently-wrong doc.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const HTML_PATH = resolve(REPO_ROOT, "lab/lite/docs/feature-comparison.html");
const DOC_PATH = resolve(REPO_ROOT, "docs/lite/02-feature-comparison.md");

const MARKER_START = "<!-- AUTOGEN:feature-comparison START — generated from lab/lite/docs/feature-comparison.html by scripts/gen-feature-comparison.ts. Do not edit between these markers by hand. -->";
const MARKER_END = "<!-- AUTOGEN:feature-comparison END -->";

interface FeatureRow {
    feature: string;
    lite: string;
    bjs: string;
    notes: string;
    highlight: boolean;
}

interface Category {
    name: string;
    rows: FeatureRow[];
}

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

/** Strip any inline tags, decode entities, and collapse whitespace to single spaces. */
function cleanCell(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Escape characters that would break a markdown table cell. */
function escapeCell(text: string): string {
    return text.replace(/\|/g, "\\|");
}

function parseHtml(html: string): Category[] {
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (!tbodyMatch) {
        throw new Error(`Could not find <tbody> in ${HTML_PATH}`);
    }
    const tbody = tbodyMatch[1]!;

    const categories: Category[] = [];
    let current: Category | undefined;

    const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
    for (const rowMatch of tbody.matchAll(rowRe)) {
        const attrs = rowMatch[1] ?? "";
        const inner = rowMatch[2] ?? "";
        const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanCell(m[1] ?? ""));

        if (/\bfeat-cat\b/.test(attrs)) {
            current = { name: cells[0] ?? "", rows: [] };
            if (!current.name) {
                throw new Error("Encountered a feat-cat row with an empty category name.");
            }
            categories.push(current);
            continue;
        }

        if (cells.length < 3) {
            throw new Error(`Feature row has ${cells.length} cells (expected 4): ${JSON.stringify(cells)}`);
        }
        if (!current) {
            throw new Error("Encountered a feature row before any category header.");
        }
        current.rows.push({
            feature: cells[0] ?? "",
            lite: cells[1] ?? "",
            bjs: cells[2] ?? "",
            notes: cells[3] ?? "",
            highlight: /\bfeat-highlight\b/.test(attrs),
        });
    }

    if (categories.length === 0) {
        throw new Error("Parsed zero categories from the feature-comparison HTML.");
    }
    return categories;
}

function renderMarkdown(categories: Category[]): string {
    const sections = categories.map((cat) => {
        const lines = [`## ${cat.name}`, "", "| Feature | Lite | BJS | Notes |", "| --- | :---: | :---: | --- |"];
        for (const row of cat.rows) {
            const feature = `${row.highlight ? "★ " : ""}${escapeCell(row.feature)}`;
            lines.push(`| ${feature} | ${row.lite} | ${row.bjs} | ${escapeCell(row.notes)} |`);
        }
        return lines.join("\n");
    });
    return sections.join("\n\n---\n\n");
}

function spliceDoc(doc: string, generated: string): string {
    const startIdx = doc.indexOf(MARKER_START);
    const endIdx = doc.indexOf(MARKER_END);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        throw new Error(`Could not find AUTOGEN markers in ${DOC_PATH}. Expected both:\n  ${MARKER_START}\n  ${MARKER_END}`);
    }
    const before = doc.slice(0, startIdx);
    const after = doc.slice(endIdx + MARKER_END.length);
    return `${before}${MARKER_START}\n\n${generated}\n\n${MARKER_END}${after}`;
}

export interface SyncResult {
    changed: boolean;
    categories: number;
    features: number;
}

/**
 * Regenerate the feature-comparison doc from the lab HTML.
 *
 * @param check  when true, do not write — only report whether the doc is stale.
 * @returns      whether the doc changed (or would change, in check mode) plus counts.
 */
export function syncFeatureDoc(check = false): SyncResult {
    const html = readFileSync(HTML_PATH, "utf-8");
    // Normalize to LF so output is deterministic regardless of the working-copy line
    // endings (the repo stores LF; CI runs on Linux). Without this, a CRLF working copy
    // on Windows would make `--check` disagree with Linux CI.
    const doc = readFileSync(DOC_PATH, "utf-8").replace(/\r\n/g, "\n");

    const categories = parseHtml(html);
    const generated = renderMarkdown(categories);
    const next = spliceDoc(doc, generated);
    const features = categories.reduce((n, c) => n + c.rows.length, 0);

    if (next === doc) {
        return { changed: false, categories: categories.length, features };
    }
    if (!check) {
        writeFileSync(DOC_PATH, next);
    }
    return { changed: true, categories: categories.length, features };
}

function main(): void {
    const checkOnly = process.argv.includes("--check");
    const result = syncFeatureDoc(checkOnly);

    if (!result.changed) {
        console.log("feature-comparison.md is up to date with the lab HTML.");
        return;
    }
    if (checkOnly) {
        console.error("docs/lite/02-feature-comparison.md is OUT OF SYNC with lab/lite/docs/feature-comparison.html.");
        console.error("Run `pnpm gen:feature-doc` and commit the result.");
        process.exit(1);
    }
    console.log(`Updated docs/lite/02-feature-comparison.md (${result.categories} categories, ${result.features} features).`);
}

// Only run the CLI when invoked directly, not when imported by the PR driver.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main();
}
