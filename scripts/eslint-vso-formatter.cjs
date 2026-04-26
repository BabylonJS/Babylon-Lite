/**
 * Custom ESLint formatter that emits ##vso[task.logissue] commands
 * so lint errors appear as Azure Pipelines annotations on the PR.
 *
 * Usage: eslint . --format ./scripts/eslint-vso-formatter.cjs
 */
module.exports = function (results) {
    const lines = [];
    for (const result of results) {
        for (const msg of result.messages) {
            const type = msg.severity === 2 ? "error" : "warning";
            const file = result.filePath;
            const line = msg.line || 0;
            const col = msg.column || 0;
            const text = `${msg.ruleId || "eslint"}: ${msg.message}`;
            lines.push(`##vso[task.logissue type=${type};sourcepath=${file};linenumber=${line};columnnumber=${col}]${text}`);
        }
    }
    // Return empty string — all output is via ##vso side-channel
    return lines.join("\n");
};
