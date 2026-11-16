/**
 * Right-handed drift guard — fails as soon as a left-handed branch changes without its right-handed twin.
 *
 * Every `_rightHanded` decision in the engine (`_rightHanded ? rh : lh`, `if (_rightHanded !== null) {rh} lh`,
 * `_rightHanded && rh`, …) is reduced to the token difference between its right-handed and left-handed code
 * and compared with the committed snapshot. Editing both branches the same way keeps the difference, so the
 * test stays green; editing only one branch changes it, so the test fails and names the site. When the new
 * difference is intended (the right-handed port itself changed), review it and update with `vitest -u`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../packages/babylon-lite/src");
const SEAM_IMPORT = /from\s+"#coordinate-system"/;

function listTs(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listTs(path) : name.endsWith(".ts") ? [path] : [];
    });
}

/** Code tokens, comments dropped: rewording a comment is not drift. */
const tokenize = (code: string): string[] => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ").match(/[\w.]+|[^\s\w]/g) ?? [];

/** Token difference `rh` vs `lh`: each changed run as `«lh» → «rh»` with two tokens of context. */
function tokenDiff(lh: string, rh: string): string {
    const a = tokenize(lh);
    const b = tokenize(rh);
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        }
    }
    const ops: { op: "=" | "-" | "+"; tok: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            ops.push({ op: "=", tok: a[i++]! });
            j++;
        } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
            ops.push({ op: "+", tok: b[j++]! });
        } else {
            ops.push({ op: "-", tok: a[i++]! });
        }
    }
    const hunks: string[] = [];
    for (let k = 0; k < ops.length;) {
        if (ops[k]!.op === "=") {
            k++;
            continue;
        }
        const start = k;
        while (k < ops.length && ops[k]!.op !== "=") {
            k++;
        }
        const run = ops.slice(start, k);
        const before = ops
            .slice(Math.max(0, start - 2), start)
            .map((o) => o.tok)
            .join(" ");
        const after = ops
            .slice(k, k + 2)
            .map((o) => o.tok)
            .join(" ");
        const removed = run.filter((o) => o.op === "-").map((o) => o.tok);
        const added = run.filter((o) => o.op === "+").map((o) => o.tok);
        hunks.push(`${before} «${removed.join(" ")}» → «${added.join(" ")}» ${after}`.trim());
    }
    return hunks.join(" … ");
}

const isSeam = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === "_rightHanded";
const unparen = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unparen(node.expression) : node);

/** Name of the declaration enclosing `node`, so site keys survive unrelated edits that move lines. */
function ownerName(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) && n.name) {
            return n.name.getText();
        }
    }
    return "<module>";
}

/** Code that runs in a left-handed build in place of an `if (_rightHanded …) { … return …; }` block. */
function fallThrough(stmt: ts.IfStatement): ts.Node[] {
    if (stmt.elseStatement) {
        return [stmt.elseStatement];
    }
    const then = stmt.thenStatement;
    const last = ts.isBlock(then) ? then.statements[then.statements.length - 1] : then;
    if (!last || !ts.isReturnStatement(last) || !ts.isBlock(stmt.parent)) {
        return [];
    }
    const siblings = stmt.parent.statements;
    return siblings.slice(siblings.indexOf(stmt) + 1);
}

function decisionsOf(path: string): Record<string, string> {
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const text = (nodes: readonly ts.Node[]): string => nodes.map((n) => (ts.isBlock(n) ? text(n.statements) : n.getText(sf))).join("\n");
    const sites: Record<string, string> = {};
    const seen = new Set<ts.Node>();
    const add = (owner: ts.Node, kind: string, lh: string, rh: string): void => {
        if (seen.has(owner)) {
            return;
        }
        seen.add(owner);
        const base = `${ownerName(owner)} ${kind}`;
        let key = base;
        for (let n = 2; key in sites; n++) {
            key = `${base} #${n}`;
        }
        sites[key] = tokenDiff(lh, rh);
    };
    const visit = (node: ts.Node): void => {
        if (isSeam(node) && !ts.isImportSpecifier(node.parent)) {
            let n: ts.Node = node;
            while (ts.isParenthesizedExpression(n.parent)) {
                n = n.parent;
            }
            const parent = n.parent;
            if (ts.isConditionalExpression(parent) && parent.condition === n) {
                add(parent, "?:", parent.whenFalse.getText(sf), parent.whenTrue.getText(sf));
            } else if (ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                add(parent, "&&", "", parent.right.getText(sf));
            } else if (ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                add(parent, "||", parent.right.getText(sf), "true");
            } else if (ts.isBinaryExpression(parent) && unparen(parent.right).kind === ts.SyntaxKind.NullKeyword) {
                const negated = parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
                let cond: ts.Node = parent;
                while (ts.isBinaryExpression(cond.parent) || ts.isParenthesizedExpression(cond.parent)) {
                    cond = cond.parent;
                }
                const stmt = cond.parent;
                if (ts.isIfStatement(stmt) && stmt.expression === cond) {
                    const then = text([stmt.thenStatement]);
                    const other = text(fallThrough(stmt));
                    add(stmt, negated ? "if-lh" : "if-rh", negated ? then : other, negated ? other : then);
                } else {
                    add(parent, "null-test", parent.getText(sf), parent.getText(sf));
                }
            } else {
                let stmt: ts.Node = parent;
                while (!ts.isStatement(stmt) && stmt.parent) {
                    stmt = stmt.parent;
                }
                add(stmt, "use", "", stmt.getText(sf));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return sites;
}

/** Code a left-handed build drops: the right-handed side of every `_rightHanded` decision in the file. */
function rightHandedOnly(sf: ts.SourceFile): ts.Node[] {
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
        if (isSeam(node) && !ts.isImportSpecifier(node.parent)) {
            let n: ts.Node = node;
            while (ts.isParenthesizedExpression(n.parent)) {
                n = n.parent;
            }
            const parent = n.parent;
            if (ts.isConditionalExpression(parent) && parent.condition === n) {
                nodes.push(parent.whenTrue);
            } else if (ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                nodes.push(parent.right);
            } else if (ts.isBinaryExpression(parent) && unparen(parent.right).kind === ts.SyntaxKind.NullKeyword) {
                let cond: ts.Node = parent;
                while (ts.isBinaryExpression(cond.parent) || ts.isParenthesizedExpression(cond.parent)) {
                    cond = cond.parent;
                }
                const stmt = cond.parent;
                if (ts.isIfStatement(stmt) && stmt.expression === cond && cond === parent) {
                    if (parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
                        nodes.push(stmt.thenStatement);
                    } else {
                        nodes.push(...fallThrough(stmt));
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return nodes;
}

/** Imported value bindings that only right-handed code uses: each one is an RH-only symbol living in another module. */
function rightHandedOnlyImports(path: string): string[] {
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = new Set<string>();
    for (const stmt of sf.statements) {
        const named = ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly ? stmt.importClause?.namedBindings : undefined;
        if (named && ts.isNamedImports(named)) {
            for (const spec of named.elements) {
                if (!spec.isTypeOnly && spec.name.text !== "_rightHanded") {
                    imports.add(spec.name.text);
                }
            }
        }
    }
    const rhOnly = rightHandedOnly(sf);
    const insideRh = (node: ts.Node): boolean => {
        for (let n: ts.Node | undefined = node; n; n = n.parent) {
            if (rhOnly.includes(n)) {
                return true;
            }
        }
        return false;
    };
    const inType = (node: ts.Node): boolean => {
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
            if (ts.isTypeNode(n) || ts.isImportDeclaration(n)) {
                return true;
            }
        }
        return false;
    };
    const usedInRh = new Set<string>();
    const usedInLh = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && imports.has(node.text) && !inType(node)) {
            (insideRh(node) ? usedInRh : usedInLh).add(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...usedInRh].filter((name) => !usedInLh.has(name)).sort();
}

const seamFiles = listTs(SRC)
    .filter((path) => SEAM_IMPORT.test(readFileSync(path, "utf8")))
    .map((path) => [relative(SRC, path).replace(/\\/g, "/"), path] as const)
    .sort(([a], [b]) => a.localeCompare(b));

describe("right-handed drift guard", () => {
    it("finds the engine's handedness seams", () => {
        expect(seamFiles.length).toBeGreaterThan(50);
    });

    it.each(seamFiles)("%s: right-handed branches still differ from their left-handed twins only by the reviewed port", (_rel, path) => {
        const sites = decisionsOf(path);
        expect(Object.keys(sites).length, "a file importing #coordinate-system must use _rightHanded").toBeGreaterThan(0);
        expect(sites).toMatchSnapshot();
    });
});

describe("right-handed code is free in a left-handed build", () => {
    // The bundler only folds `_rightHanded` once each chunk is minified. A right-handed branch that calls a
    // function imported from another module drops the call but not the function: whenever the two modules
    // land in different chunks, the shared chunk keeps exporting it, and every left-handed bundle pays for it.
    it("no right-handed branch imports a symbol the left-handed code of its file does not use", () => {
        const offenders = seamFiles.flatMap(([rel, path]) => rightHandedOnlyImports(path).map((name) => `${rel}: ${name}`));
        expect(offenders, "inline right-handed-only helpers in the module that uses them (non-exported), so the minifier drops them with the branch").toEqual([]);
    });
});
