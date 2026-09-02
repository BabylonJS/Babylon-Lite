/**
 * Shared WGSL minification Vite plugin.
 *
 * Used both by the scene/demo bundle harness (scripts/bundle-scenes-core.ts,
 * bundle-demos-core.ts) AND by the published package build
 * (packages/babylon-lite/vite.config.ts). Keeping it in one place ensures the
 * shipped `@babylonjs/lite` package and the bundle-size measurements minify WGSL
 * identically, so the harness can measure the real published artifact.
 *
 * Two minification paths (see {@link wgslMinifyPlugin}):
 *   - `transform` on `?raw` `.wgsl` imports → miniray whitespace removal and identifier
 *     mangling. This is where the bulk of WGSL lives (standalone `.wgsl` shader files).
 *   - `transform` on TypeScript source → strips comments/whitespace from template
 *     literals tagged by the imported `wgsl` helper, preserving `${...}` expressions.
 */
import { type Plugin } from "vite";
import { initialize as initMiniray, minify as minifyWgslMiniray } from "miniray";
import MagicString from "magic-string";
import ts from "typescript";

const WGSL_TAG_MODULE_RE = /(?:^|\/)wgsl\.js$/;
const WGSL_MULTI_CHAR_TOKENS = new Set(["->", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "++", "--", "//", "/*", "*/"]);
const WGSL_INJECTION_MARKER_RE = /^\/\*[A-Z][A-Z0-9_]*\*\/$/;

/** WGSL recognizes only these ASCII characters as token-separating whitespace. */
function isWgslWhitespace(ch: string): boolean {
    return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/**
 * Determine whether removed whitespace must remain as one space. Besides preventing
 * identifier/number fusion, this avoids accidentally creating a multi-character operator
 * or comment delimiter from two separate tokens.
 */
function needsWgslSeparator(previous: string, next: string): boolean {
    const word = /[A-Za-z0-9_]/;
    return (word.test(previous) && word.test(next)) || WGSL_MULTI_CHAR_TOKENS.has(previous + next);
}

/**
 * Minify one static section of a tagged template without inspecting its expressions.
 * Each quasi is processed independently, so whitespace adjacent to `${...}` is preserved
 * when present: the expression may produce an identifier that must not merge with a static token.
 */
function minifyTaggedWgslText(code: string, preserveLeadingSpace: boolean, preserveTrailingSpace: boolean): string {
    let out = "";
    // Defer whitespace until the next token is known; most punctuation needs no separator.
    let pendingSpace = false;
    let i = 0;
    while (i < code.length) {
        const ch = code[i]!;
        if (isWgslWhitespace(ch)) {
            pendingSpace = true;
            i++;
            continue;
        }
        if (ch === "/" && code[i + 1] === "/") {
            pendingSpace = true;
            i += 2;
            let endedBeforeBoundary = false;
            while (i < code.length && code[i] !== "\n" && code[i] !== "\r") {
                if (code[i] === "\\" && (code[i + 1] === "n" || code[i + 1] === "r")) {
                    i += 2;
                    endedBeforeBoundary = true;
                    break;
                }
                i++;
            }
            // Removing a comment that continues through an interpolation would change which
            // runtime text is commented out, so reject that composition instead of guessing.
            if (i === code.length && preserveTrailingSpace && !endedBeforeBoundary) {
                throw new Error("WGSL line comments cannot cross a tagged-template interpolation boundary.");
            }
            continue;
        }
        if (ch === "/" && code[i + 1] === "*") {
            const end = code.indexOf("*/", i + 2);
            if (end < 0) {
                throw new Error("WGSL block comments cannot cross a tagged-template interpolation boundary.");
            }
            const comment = code.slice(i, end + 2);
            // Runtime shader composition replaces uppercase block-comment markers such as
            // `/*SU*/` and `/*GS_FRAGMENT_DEFINITIONS*/`; ordinary comments are discarded.
            if (WGSL_INJECTION_MARKER_RE.test(comment)) {
                if (pendingSpace && (out.length > 0 || preserveLeadingSpace)) {
                    out += " ";
                }
                out += comment;
                pendingSpace = false;
                i = end + 2;
                continue;
            }
            pendingSpace = true;
            i = end + 2;
            continue;
        }
        if (ch === "\\") {
            // Escaped whitespace has the same runtime meaning as literal whitespace in a template.
            if (code[i + 1] === "n" || code[i + 1] === "r" || code[i + 1] === "t") {
                pendingSpace = true;
                i += 2;
                continue;
            }
            // Preserve all other JavaScript template escapes verbatim.
            if (pendingSpace) {
                if ((out.length === 0 && preserveLeadingSpace) || (out.length > 0 && needsWgslSeparator(out.at(-1)!, ch))) {
                    out += " ";
                }
                pendingSpace = false;
            }
            out += code.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (pendingSpace) {
            // At an interpolation boundary the neighboring token is unknown; internally,
            // retain a separator only when removing it could create a different WGSL token.
            if ((out.length === 0 && preserveLeadingSpace) || (out.length > 0 && needsWgslSeparator(out.at(-1)!, ch))) {
                out += " ";
            }
            pendingSpace = false;
        }
        out += ch;
        i++;
    }
    if (pendingSpace && preserveTrailingSpace) {
        out += " ";
    }
    return out;
}

/**
 * Find the local names of explicit `wgsl` named imports, including aliases. Requiring the
 * helper import prevents unrelated tags or variables named `wgsl` from being transformed.
 */
function taggedWgslBindings(sourceFile: ts.SourceFile): Set<string> {
    const bindings = new Set<string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !WGSL_TAG_MODULE_RE.test(statement.moduleSpecifier.text.replace(/\\/g, "/"))) {
            continue;
        }
        const namedBindings = statement.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
            continue;
        }
        for (const element of namedBindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) === "wgsl") {
                bindings.add(element.name.text);
            }
        }
    }
    return bindings;
}

/**
 * Conservatively reject any runtime binding that reuses an imported tag name. The transform
 * intentionally avoids a full TypeScript program/type checker, so rejecting shadowing is safer
 * than syntactically mistaking a local tag for the imported WGSL helper.
 */
function shadowingBinding(sourceFile: ts.SourceFile, bindings: ReadonlySet<string>): ts.Identifier | null {
    let shadow: ts.Identifier | null = null;
    // Binding patterns may hide the conflicting identifier inside array/object destructuring.
    const findBinding = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
            if (bindings.has(name.text)) {
                shadow = name;
            }
            return;
        }
        for (const element of name.elements) {
            if (ts.isBindingElement(element)) {
                findBinding(element.name);
            }
        }
    };
    // Imports are skipped because they contain the legitimate binding being checked.
    const visit = (node: ts.Node): void => {
        if (shadow || ts.isImportDeclaration(node)) {
            return;
        }
        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
            findBinding(node.name);
        } else if (
            (ts.isFunctionDeclaration(node) ||
                ts.isFunctionExpression(node) ||
                ts.isClassDeclaration(node) ||
                ts.isClassExpression(node) ||
                ts.isEnumDeclaration(node) ||
                ts.isModuleDeclaration(node)) &&
            node.name &&
            ts.isIdentifier(node.name) &&
            bindings.has(node.name.text)
        ) {
            shadow = node.name;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return shadow;
}

/**
 * Transform only explicitly imported `wgsl` tagged templates, leaving all other templates
 * untouched. TypeScript supplies reliable template/expression boundaries; MagicString applies
 * edits to the original source so interpolation code and source mappings remain intact.
 */
export function transformTaggedWgsl(code: string, id: string): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
    const cleanId = id.split("?")[0]!;
    // Avoid parsing assets and the overwhelmingly common case with no helper import.
    if (!/\.[cm]?[jt]sx?$/.test(cleanId) || !code.includes("wgsl")) {
        return null;
    }
    const scriptKind = cleanId.endsWith("x")
        ? ts.ScriptKind.TSX
        : cleanId.endsWith(".js") || cleanId.endsWith(".mjs") || cleanId.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(cleanId, code, ts.ScriptTarget.Latest, true, scriptKind);
    const bindings = taggedWgslBindings(sourceFile);
    if (bindings.size === 0) {
        return null;
    }
    const shadow = shadowingBinding(sourceFile, bindings);
    if (shadow) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(shadow.getStart(sourceFile));
        throw new Error(`Imported WGSL tag "${shadow.text}" is shadowed by another binding at ${cleanId}:${line + 1}:${character + 1}. Rename the local binding.`);
    }

    const output = new MagicString(code);
    let changed = false;
    // Template node ranges include their delimiters; overwrite only the static text within.
    const rewriteLiteral = (contentStart: number, contentEnd: number, preserveLeadingSpace: boolean, preserveTrailingSpace: boolean): void => {
        const original = code.slice(contentStart, contentEnd);
        const minified = minifyTaggedWgslText(original, preserveLeadingSpace, preserveTrailingSpace);
        if (minified !== original) {
            output.overwrite(contentStart, contentEnd, minified);
        }
    };
    // Removing the tag restores a plain runtime template. Each quasi is rewritten separately,
    // while TypeScript's expression nodes are deliberately never inspected or modified.
    const visit = (node: ts.Node): void => {
        if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && bindings.has(node.tag.text)) {
            output.remove(node.tag.getStart(sourceFile), node.template.getStart(sourceFile));
            if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
                rewriteLiteral(node.template.getStart(sourceFile) + 1, node.template.getEnd() - 1, false, false);
            } else {
                const head = node.template.head;
                rewriteLiteral(head.getStart(sourceFile) + 1, head.getEnd() - 2, false, true);
                for (const span of node.template.templateSpans) {
                    const literal = span.literal;
                    const isTail = ts.isTemplateTail(literal);
                    rewriteLiteral(literal.getStart(sourceFile) + 1, literal.getEnd() - (isTail ? 1 : 2), true, !isTail);
                }
            }
            changed = true;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (!changed) {
        return null;
    }
    return {
        code: output.toString(),
        map: output.generateMap({ hires: true, includeContent: true, source: cleanId }),
    };
}

function replaceWgslIdentifiers(code: string, replacements: readonly (readonly [string, string])[]): string {
    let out = code;
    for (const [from, to] of replacements) {
        out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return out;
}

function mangleGaussianSplattingWgsl(code: string): string {
    // KEEP IN SYNC with the runtime mangling table in
    // `packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts:applyGsFragments`.
    // The runtime version normalises any spliced fragment-plugin code to use these
    // mangled names so the WebGPU compiler sees a single consistent identifier set.
    return replaceWgslIdentifiers(code, [
        ["world", "w"],
        ["view", "v"],
        ["projection", "p"],
        ["viewport", "vp"],
        ["focal", "f"],
        ["dataSize", "ds"],
        ["alpha", "a"],
        ["_pad", "_p"],
        ["vColor", "vc"],
        ["vPos", "vq"],
        ["dataUv", "du"],
        ["splatIndex", "si"],
        ["corner", "co"],
        ["center", "ce"],
        ["color", "cl"],
        ["covA", "ca"],
        ["covB", "cb"],
        ["worldPos", "wp"],
        ["modelView", "mv"],
        ["camspace", "cs"],
        ["pos2d", "p2"],
        ["bounds", "bd"],
        ["Vrk", "vr"],
        ["invZ2", "iz2"],
        ["invZ", "iz"],
        ["cov2d", "c2"],
        ["kernelSize", "ks"],
        ["radius", "ra"],
        ["epsilon", "ep"],
        ["lambda1", "l1"],
        ["lambda2", "l2"],
        ["diag", "dg"],
        ["majorAxis", "ma"],
        ["minorAxis", "mi"],
        ["vCenter", "vc2"],
    ]);
}

/**
 * Vite plugin: minify WGSL shader text using miniray (whitespace removal + identifier mangling).
 * For `?raw` WGSL imports: miniray minifies whitespace AND short-renames module/local identifiers.
 *   - Caveat 1: miniray's mangler does NOT guard against shadowing module-scope vars (e.g. it may
 *     rename a local to the same letter as a uniform binding). We pass `keepNames: ["u", "in",
 *     "finalColor"]` for `gaussian-splatting.wgsl` to reserve (a) the uniform binding name `u`
 *     so locals don't collide with it (otherwise WGSL parsing fails with "cannot index into
 *     mat3x3"), and (b) the fragment-stage identifiers `in` (parameter) / `finalColor` (local)
 *     that runtime fragment-plugin code (`gsLinearDepthFragment` etc.) references.
 *   - Caveat 2: miniray strips block comments. The GS shaders embed `/* GS_FRAGMENT_* *\/`
 *     markers used by `applyGsFragments` to splice in fragment-plugin code at runtime. We
 *     encode each marker as a `const _GS_FRAGMENT_X_:u32=0u;` declaration before miniray
 *     (which survives with `treeShaking: false`), then decode back to a comment marker
 *     after minification — keeping the runtime API and source format unchanged.
 * For explicitly tagged TypeScript templates: AST-targeted comment/whitespace stripping.
 * Gaussian-splatting raw WGSL gets a small shader-specific identifier compaction pass.
 */
export function wgslMinifyPlugin(): Plugin {
    return {
        name: "wgsl-minify",
        enforce: "pre",
        async buildStart() {
            await initMiniray({});
        },
        transform(code: string, id: string) {
            if (id.includes(".wgsl")) {
                const match = code.match(/^export default "(.*)"$/s);
                if (!match) return null;
                const raw = JSON.parse(`"${match[1]}"`);
                const isGs = id.includes("gaussian-splatting.wgsl");
                // Encode `/* GS_FRAGMENT_X */` comment markers as const declarations so they
                // survive miniray's comment stripping. Decoded back below.
                const encoded = isGs ? raw.replace(/\/\*(GS_FRAGMENT_\w+)\*\//g, "const _$1_:u32=0u;") : raw;
                const result = minifyWgslMiniray(encoded, isGs ? { keepNames: ["u", "in", "finalColor"], treeShaking: false } : {});
                let minified = typeof result === "string" ? result : result.code;
                if (isGs) {
                    minified = minified.replace(/const\s+_(GS_FRAGMENT_\w+)_\s*:\s*u32\s*=\s*0u\s*;/g, "/*$1*/");
                }
                const compact = isGs ? mangleGaussianSplattingWgsl(minified) : minified;
                return { code: `export default ${JSON.stringify(compact)}`, map: null };
            }
            return transformTaggedWgsl(code, id);
        },
    };
}
