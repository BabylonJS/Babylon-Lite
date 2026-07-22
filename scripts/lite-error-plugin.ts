/**
 * Lite error-string optimization Vite plugin.
 *
 * Developer-facing `throw new Error("…")` messages are pure overhead in a shipped bundle: the
 * verbose English text is dead weight unless an error actually fires, and it gzips poorly. This
 * plugin moves that text out of the hot path.
 *
 * At build time it rewrites qualifying `throw new Error(<string|template>)` sites to
 * `ThrowLiteError(code, …interpArgs)` (see `src/lite-error.ts`) and gathers every original
 * message into a single generated `code → message` table that replaces the placeholder body of
 * `src/error-messages.ts`. That table is its own module/chunk and is only pulled in when the app
 * references a decoding entry point — `enableErrorDecoding()` (global decoder) or `decodeError()`
 * (on-demand, single caught error) — so by default the bundle ships numeric codes, not prose.
 *
 * Determinism: codes are assigned in a stable order (relative file path, then source position)
 * during `buildStart`, independent of Vite's parallel per-module `transform` ordering, so the
 * same source always yields the same codes and table.
 *
 * Safety guards:
 *   - Only `new Error(stringLiteral | template)` is rewritten (static messages); dynamic/`Error`
 *     subclasses and non-string args are left untouched.
 *   - A per-file byte guard skips files whose total rewrite savings would not cover the one-time
 *     `import { ThrowLiteError }` cost, so the transform never makes a module larger.
 *   - `transform` re-parses the module Vite hands it and zips throws (in source order) with the
 *     codes assigned in `buildStart`, so it never relies on cross-pass byte offsets.
 */
import { type Plugin } from "vite";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

interface Candidate {
    /** Replace [start, end) of the source (the `throw new Error(...)` expression). */
    start: number;
    end: number;
    /** Source for the table entry, e.g. `() => "msg"` or `(a0) => `msg ${a0}``. */
    tableFnSource: string;
    /** Argument expression source texts forwarded at the call site. */
    argTexts: string[];
    /** Replacement length excluding the code number. */
    rewrittenLenSansCode: number;
    /** Original `throw new Error(...)` expression length. */
    originalLen: number;
}

interface FilePlan {
    /** Codes assigned to each rewritten throw, in source order. */
    codes: number[];
    /** Relative POSIX import specifier to `lite-error.js`. */
    importSpecifier: string;
}

const HELPER_BASENAMES = new Set(["lite-error.ts", "error-messages.ts", "enable-error-decoding.ts"]);

function walkTsFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
                out.push(full);
            }
        }
    }
    return out;
}

/** Re-escape already-cooked template text so it can be embedded inside a new template literal. */
function escapeForTemplate(cooked: string): string {
    return cooked.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Inspect one `throw new Error(<arg>)`; return a rewrite candidate, or null to leave it as-is. */
function candidateFor(node: ts.ThrowStatement, sf: ts.SourceFile): Candidate | null {
    const expr = node.expression;
    if (!ts.isNewExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "Error") {
        return null;
    }
    const args = expr.arguments;
    if (!args || args.length !== 1) {
        return null;
    }
    const arg = args[0];

    let tableFnSource: string;
    const argTexts: string[] = [];

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        tableFnSource = `() => ${JSON.stringify(arg.text)}`;
    } else if (ts.isTemplateExpression(arg)) {
        let body = escapeForTemplate(arg.head.text);
        arg.templateSpans.forEach((span, i) => {
            argTexts.push(span.expression.getText(sf));
            body += `\${a${i}}` + escapeForTemplate(span.literal.text);
        });
        const params = argTexts.map((_, i) => `a${i}`).join(", ");
        tableFnSource = `(${params}) => \`${body}\``;
    } else {
        return null;
    }

    const start = node.getStart(sf);
    const end = expr.getEnd();
    const callArgs = argTexts.length ? ", " + argTexts.join(", ") : "";
    const rewrittenLenSansCode = "ThrowLiteError(".length + callArgs.length + ")".length;

    return { start, end, tableFnSource, argTexts, rewrittenLenSansCode, originalLen: end - start };
}

/** Collect rewrite candidates from a module's source, in source order. */
function collectCandidates(text: string, fileName: string): Candidate[] {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const candidates: Candidate[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isThrowStatement(node)) {
            const c = candidateFor(node, sf);
            if (c) {
                candidates.push(c);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return candidates;
}

export function liteErrorPlugin(): Plugin {
    const srcRoot = path.resolve(__dirname, "../packages/babylon-lite/src");
    const liteErrorFile = path.join(srcRoot, "lite-error.ts");
    const errorMessagesFile = path.join(srcRoot, "error-messages.ts");

    const plans = new Map<string, FilePlan>(); // normalized abs path -> plan
    let tableModuleSource = "";

    const normalize = (id: string): string => path.resolve(id.split("?")[0]).replace(/\\/g, "/");

    return {
        name: "lite-error",
        enforce: "pre",

        buildStart() {
            plans.clear();
            const files = walkTsFiles(srcRoot).sort((a, b) => a.localeCompare(b));
            const tableEntries: string[] = [];
            let nextCode = 0;

            for (const file of files) {
                if (HELPER_BASENAMES.has(path.basename(file))) {
                    continue;
                }
                const candidates = collectCandidates(fs.readFileSync(file, "utf8"), file);
                if (candidates.length === 0) {
                    continue;
                }

                let rel = path.relative(path.dirname(file), liteErrorFile).replace(/\\/g, "/").replace(/\.ts$/, ".js");
                if (!rel.startsWith(".")) {
                    rel = "./" + rel;
                }
                const importLen = `import { ThrowLiteError } from "${rel}";\n`.length;

                const codeWidth = String(nextCode + candidates.length).length;
                let totalSavings = 0;
                for (const c of candidates) {
                    totalSavings += c.originalLen - (c.rewrittenLenSansCode + codeWidth);
                }
                if (totalSavings <= importLen) {
                    continue;
                }

                const codes = candidates.map((c) => {
                    const code = nextCode++;
                    tableEntries.push(`/*${code}*/ ${c.tableFnSource},`);
                    return code;
                });
                plans.set(normalize(file), { codes, importSpecifier: rel });
            }

            tableModuleSource =
                `/* GENERATED by scripts/lite-error-plugin.ts — do not edit. */\n` +
                `const T: Array<(...a: any[]) => string> = [\n${tableEntries.join("\n")}\n];\n` +
                `export function decodeLiteError(code: number, args: readonly unknown[]): string {\n` +
                `    const fn = T[code];\n` +
                `    return fn ? fn(...args) : \`Error #\${code}\`;\n` +
                `}\n`;
        },

        transform(code, id) {
            const norm = normalize(id);

            if (norm === normalize(errorMessagesFile)) {
                return { code: tableModuleSource, map: null };
            }

            const plan = plans.get(norm);
            if (!plan) {
                return null;
            }

            // Re-parse what Vite handed us and zip with the codes assigned in buildStart (same
            // deterministic source order), so offsets always come from THIS module text.
            const candidates = collectCandidates(code, id);
            if (candidates.length !== plan.codes.length) {
                this.error(`lite-error: throw count drift in ${id} (saw ${candidates.length}, planned ${plan.codes.length})`);
            }

            let out = code;
            for (let i = candidates.length - 1; i >= 0; i--) {
                const c = candidates[i];
                const callArgs = c.argTexts.length ? ", " + c.argTexts.join(", ") : "";
                const replacement = `ThrowLiteError(${plan.codes[i]}${callArgs})`;
                out = out.slice(0, c.start) + replacement + out.slice(c.end);
            }
            out = `import { ThrowLiteError } from "${plan.importSpecifier}";\n` + out;

            return { code: out, map: null };
        },
    };
}
