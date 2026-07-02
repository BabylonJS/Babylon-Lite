/**
 * Redact BrowserStack credentials from test artifacts before they are published.
 *
 * The parity job connects to BrowserStack over CDP, and the wsEndpoint embeds
 * BROWSERSTACK_ACCESS_KEY. On a connection failure Playwright can echo that URL
 * into the HTML report / JUnit XML, which the pipeline uploads to a public host.
 * This strips the credential values from those artifacts as a safety net.
 *
 * Usage: tsx scripts/redact-secrets.ts <dir> [...moreDirs]
 *   Secrets are read from BROWSERSTACK_ACCESS_KEY and BROWSERSTACK_USERNAME.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { extname, resolve } from "path";

const TEXT_EXTENSIONS = new Set([".html", ".xml", ".json", ".txt", ".js", ".md", ".log"]);
const PLACEHOLDER = "***";

const secrets = [process.env.BROWSERSTACK_ACCESS_KEY, process.env.BROWSERSTACK_USERNAME]
    .map((s) => (s ?? "").trim())
    // Avoid redacting trivially short/empty values that could appear legitimately.
    .filter((s) => s.length >= 6);

function redactText(text: string): string {
    let out = text;
    for (const secret of secrets) {
        if (out.includes(secret)) {
            out = out.split(secret).join(PLACEHOLDER);
        }
    }
    return out;
}

function walk(dir: string): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return; // missing dir is fine (e.g. report never generated)
    }
    for (const entry of entries) {
        const path = resolve(dir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            walk(path);
            continue;
        }
        if (!TEXT_EXTENSIONS.has(extname(path))) {
            continue;
        }
        const before = readFileSync(path, "utf-8");
        const after = redactText(before);
        if (after !== before) {
            writeFileSync(path, after);
            console.log(`[redact-secrets] redacted ${path}`);
        }
    }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
    console.error("[redact-secrets] no target directories given");
    process.exit(1);
}
if (secrets.length === 0) {
    console.log("[redact-secrets] no credentials in env; nothing to redact");
    process.exit(0);
}
for (const target of targets) {
    walk(resolve(target));
}
