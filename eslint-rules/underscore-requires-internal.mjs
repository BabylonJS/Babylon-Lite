// @ts-check
/**
 * ESLint rule: every member of an EXPORTED interface / type alias / class
 * whose name starts with an underscore must have an `@internal` JSDoc tag,
 * and every `@internal` member must start with an underscore. Paired with
 * api-extractor's `ae-internal-missing-underscore` check (configured in
 * `packages/babylon-lite/vite.config.ts`), this enforces both directions
 * of the convention documented in GUIDANCE.md §4b′.
 *
 * Only fires on members of:
 *   - exported interfaces and classes (the surfaces that matter for the public d.ts)
 *   - **type literals reachable from an exported declaration**: covers fields
 *     like `readonly bindings: { readonly _iblTexture: number }` on a public
 *     interface where the inner literal is structurally part of the public API.
 *
 * Inline type literals used purely as inline casts inside expressions
 * (`(x as { _foo?: T })._foo`) are still skipped because they are not part of
 * any exported declaration.
 *
 * Skips:
 * - Computed / non-identifier names (Symbols, brand markers, etc.)
 * - Underscore-only names (`_`)
 * - Class members with `private` / `protected` accessibility modifiers
 *   (TypeScript's own visibility handles them)
 * - Constructors: a constructor cannot be renamed to start with `_`, so the
 *   `@internal`-requires-underscore direction does not apply. `@internal` is
 *   allowed on a constructor (or a constructor overload signature) to mark an
 *   internal-only construction path.
 */

/**
 * Walk up to the containing top-level type declaration and return true when
 * it (or its `ExportNamedDeclaration` wrapper) carries an `export` keyword.
 * @param {any} node
 * @returns {boolean}
 */
function isInExportedDeclaration(node) {
    for (let cur = node; cur; cur = cur.parent) {
        if (cur.type === "TSInterfaceDeclaration" || cur.type === "TSTypeAliasDeclaration" || cur.type === "ClassDeclaration") {
            const parent = cur.parent;
            if (parent && parent.type === "ExportNamedDeclaration") {
                return true;
            }
            return false;
        }
        if (cur.type === "ExportNamedDeclaration" || cur.type === "ExportDefaultDeclaration") {
            return true;
        }
    }
    return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
    meta: {
        type: "problem",
        docs: {
            description: "On exported types: underscore-prefixed members must carry @internal; @internal members must be underscore-prefixed.",
        },
        schema: [],
        messages: {
            underscoreRequiresInternal: "Property '{{name}}' starts with '_' on an exported type but has no `@internal` JSDoc tag.",
            internalRequiresUnderscore: "Property '{{name}}' has `@internal` but does not start with '_'.",
        },
    },
    create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();

        /**
         * @param {string} name
         * @returns {boolean}
         */
        function startsWithUnderscore(name) {
            return name.length > 1 && name.startsWith("_");
        }

        /**
         * Returns true if any leading JSDoc block comment contains an `@internal` tag.
         * @param {import("estree").Node} node
         */
        function hasInternalTag(node) {
            const comments = sourceCode.getCommentsBefore(node);
            for (const comment of comments) {
                if (comment.type !== "Block") {
                    continue;
                }
                if (!comment.value.startsWith("*")) {
                    continue;
                }
                if (/(^|\s)@internal(\s|$)/.test(comment.value)) {
                    return true;
                }
            }
            return false;
        }

        /**
         * Resolve the textual member name (or null when computed/non-identifier).
         * @param {any} key
         * @returns {string | null}
         */
        function memberName(key) {
            if (!key) {
                return null;
            }
            if (key.type === "Identifier") {
                return key.name;
            }
            if (key.type === "Literal" && typeof key.value === "string") {
                return key.value;
            }
            return null;
        }

        /**
         * @param {any} member
         */
        function checkMember(member) {
            if (!member) {
                return;
            }
            if (member.computed) {
                return;
            }
            if (member.accessibility === "private" || member.accessibility === "protected") {
                return;
            }
            // Constructors can't start with `_`, so the @internal-requires-underscore
            // direction never applies — allow `@internal` on a constructor (or one of
            // its overload signatures) to mark an internal-only construction path.
            if (member.kind === "constructor") {
                return;
            }
            if (!isInExportedDeclaration(member)) {
                return;
            }
            const name = memberName(member.key);
            if (!name) {
                return;
            }
            const underscored = startsWithUnderscore(name);
            const internal = hasInternalTag(member);
            if (underscored && !internal) {
                context.report({ node: member.key, messageId: "underscoreRequiresInternal", data: { name } });
            } else if (!underscored && internal) {
                context.report({ node: member.key, messageId: "internalRequiresUnderscore", data: { name } });
            }
        }

        return {
            TSInterfaceBody(node) {
                for (const member of node.body) {
                    checkMember(member);
                }
            },
            TSTypeLiteral(node) {
                // Only check inline type literals that are part of a declaration
                // (not used as inline expression casts).
                if (!isInExportedDeclaration(node)) {
                    return;
                }
                // Skip single-line type literals — JSDoc can't go inline next to
                // each member anyway, so flagging them adds noise without value.
                if (node.loc.start.line === node.loc.end.line) {
                    return;
                }
                // Walk up: if we hit a TSAsExpression / TSTypeAssertion / TSSatisfiesExpression
                // before reaching the top-level declaration, the type literal is an inline
                // cast, not a declaration — skip it.
                for (let cur = node.parent; cur; cur = cur.parent) {
                    if (cur.type === "TSAsExpression" || cur.type === "TSTypeAssertion" || cur.type === "TSSatisfiesExpression") {
                        return;
                    }
                    if (cur.type === "TSInterfaceDeclaration" || cur.type === "TSTypeAliasDeclaration" || cur.type === "ClassDeclaration") {
                        break;
                    }
                }
                for (const member of node.members) {
                    checkMember(member);
                }
            },
            ClassBody(node) {
                for (const member of node.body) {
                    checkMember(member);
                }
            },
        };
    },
};

export default {
    rules: {
        "underscore-requires-internal": rule,
    },
};
