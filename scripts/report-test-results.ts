/**
 * Parse JUnit XML and emit Azure Pipelines logging commands.
 *
 * ##vso[task.logissue type=error]  → shows as error annotation on GitHub PR checks
 * ##vso[task.logissue type=warning] → shows as warning annotation
 * ##vso[task.complete result=SucceededWithIssues] → marks step yellow on warnings
 *
 * SECURITY: everything this script prints is derived from a JUnit file written
 * by the test run — that is, by repository-authored code, which in PR CI is the
 * code under review. The agent obeys any logging command that starts a line of
 * step output, so a test title or failure message containing a newline followed
 * by `##vso[task.setvariable …]` would be *executed* rather than reported. Every
 * interpolated value therefore goes through `logIssue`/`neutralize` below, which
 * put the value on a single line and defang the command introducers. The failure
 * message was already collapsed by `sanitize`; the test *name* was not, and it
 * comes from the same file.
 *
 * Usage: tsx scripts/report-test-results.ts <junit-file> [<junit-file> ...]
 */
import { readFileSync, existsSync } from "fs";

const files = process.argv.slice(2).filter(Boolean);
if (files.length === 0) {
    console.log("Usage: tsx scripts/report-test-results.ts <junit-xml-file> ...");
    process.exit(0);
}

let totalTests = 0;
let totalFailed = 0;
let totalErrors = 0;
let totalSkipped = 0;
let totalWarnings = 0;

for (const file of files) {
    if (!existsSync(file)) {
        logIssue("warning", `JUnit file not found: ${file}`);
        continue;
    }

    const xml = readFileSync(file, "utf-8");

    // Parse <testsuite> attributes
    const suiteRegex = /<testsuite\s[^>]*>/g;
    let suiteMatch;
    while ((suiteMatch = suiteRegex.exec(xml)) !== null) {
        const attrs = suiteMatch[0];
        totalTests += num(attrs, "tests");
        totalFailed += num(attrs, "failures");
        totalErrors += num(attrs, "errors");
        totalSkipped += num(attrs, "skipped");
    }

    // Parse failed <testcase> elements and emit error lines
    const caseRegex = /<testcase\s([^>]*?)>([\s\S]*?)<\/testcase>/g;
    let caseMatch;
    while ((caseMatch = caseRegex.exec(xml)) !== null) {
        const cAttrs = caseMatch[1]!;
        const cBody = caseMatch[2]!;

        const failMatch = cBody.match(/<failure[^>]*?(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/failure>/);
        const errMatch = cBody.match(/<error[^>]*?(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/error>/);
        // <skipped> can be self-closing (<skipped/>) or have a body (<skipped message="…">…</skipped>)
        const skipMatch = cBody.match(/<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/);

        if (failMatch || errMatch) {
            const name = attr(cAttrs, "name");
            const msgAttr = failMatch?.[1] ?? errMatch?.[1] ?? "";
            const bodyText = (failMatch?.[2] ?? errMatch?.[2] ?? "").trim();
            // Prefer body text (has full error + expected/received), fall back to message attr
            const raw = bodyText || msgAttr || "Test failed";
            logIssue("error", `${name}: ${sanitize(raw)}`);
        } else if (skipMatch) {
            // Prefer the skip reason (test.skip(true, "[NOT A PERFORMANCE ISSUE] …") stores
            // this in <skipped message="…"> or inside the body). Fall back to annotation
            // <properties> for older Playwright versions.
            const name = attr(cAttrs, "name");
            const skipAttrs = skipMatch[1] ?? "";
            const skipBody = (skipMatch[2] ?? "").trim();
            const skipMessage = attr(skipAttrs, "message") || skipBody;
            const warnings: string[] = [];
            if (skipMessage && /\[NOT A PERFORMANCE ISSUE\]|\bwarning\b/i.test(skipMessage)) {
                warnings.push(skipMessage);
            }
            // Also consider Playwright annotation properties
            warnings.push(...extractWarningAnnotations(cBody));
            for (const w of warnings) {
                totalWarnings++;
                logIssue("warning", `${name}: ${sanitize(w)}`);
            }
        }
    }
}

const passed = totalTests - totalFailed - totalErrors - totalSkipped;
const failed = totalFailed + totalErrors;

// Summary line
console.log(`\nTest Results: ${passed} passed, ${failed} failed, ${totalSkipped} skipped, ${totalTests} total`);

if (failed > 0) {
    console.log(`##vso[task.complete result=Failed]${neutralize(String(failed))} test(s) failed`);
} else if (totalWarnings > 0) {
    console.log(`##vso[task.complete result=SucceededWithIssues]${neutralize(String(totalWarnings))} warning(s)`);
}

/**
 * Emit one `task.logissue`, with a message that cannot become a second command.
 *
 * The agent scans step output line by line and obeys anything that starts with
 * `##vso[`. A JUnit `name="…"` attribute may legally contain a raw newline — the
 * attribute regexes here match across lines — so an interpolated test title is
 * an injection point into the job running this script. `neutralize` removes the
 * only thing that makes a logging command reachable (a line break) and defangs
 * the introducer as well, so the value is reported rather than executed.
 */
function logIssue(type: "error" | "warning", message: string): void {
    console.log(`##vso[task.logissue type=${type}]${neutralize(message)}`);
}

/** One line, and no logging-command introducer left in it. */
function neutralize(text: string): string {
    return text
        .replace(/[\r\n\u2028\u2029]+/g, " ")
        .replace(/##vso\[/gi, "##vso(")
        .replace(/##\[/g, "##(");
}

function attr(str: string, name: string): string {
    const m = str.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1]! : "";
}

function num(str: string, name: string): number {
    return Number(attr(str, name)) || 0;
}

function sanitize(raw: string): string {
    return raw
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#10;/g, " ")
        .replace(/&#13;/g, "")
        .replace(/\s+at\s+.*/g, "") // strip stack trace lines
        .replace(/\r?\n/g, " ")
        .replace(/;/g, ",")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 800);
}

// Playwright's JUnit reporter emits annotations under <properties> inside <testcase>.
// Each annotation becomes a <property name="<type>" value="<description>"/> pair.
// Collect descriptions for the "warning" type.
function extractWarningAnnotations(body: string): string[] {
    const propsBlock = body.match(/<properties>([\s\S]*?)<\/properties>/);
    if (!propsBlock) return [];
    const out: string[] = [];
    const propRegex = /<property\s+([^/]*?)\/?>/g;
    let m;
    while ((m = propRegex.exec(propsBlock[1]!)) !== null) {
        const pAttrs = m[1]!;
        if (attr(pAttrs, "name").toLowerCase() === "warning") {
            const value = attr(pAttrs, "value");
            if (value) out.push(value);
        }
    }
    return out;
}
