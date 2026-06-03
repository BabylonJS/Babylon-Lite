import { readFileSync, writeFileSync } from "node:fs";

const out = readFileSync("lint.log", "utf8");
const lines = out.split(/\r?\n/);

const byFile = new Map();
let currentFile = null;
for (const line of lines) {
    const fileMatch = line.match(/^([A-Z]:\\[^\s]+\.ts)\s*$/);
    if (fileMatch) {
        currentFile = fileMatch[1];
        continue;
    }
    if (!currentFile) continue;
    const violationMatch = line.match(/^\s+(\d+):(\d+)\s+error\s+Property\s+'(_\S+)'.+underscore-requires-internal\s*$/);
    if (violationMatch) {
        const ln = parseInt(violationMatch[1], 10);
        if (!byFile.has(currentFile)) byFile.set(currentFile, new Set());
        byFile.get(currentFile).add(ln);
    }
}

let totalAdded = 0;
let totalFiles = 0;
for (const [file, lineSet] of byFile) {
    const linesArr = readFileSync(file, "utf8").split(/\r?\n/);
    const sorted = [...lineSet].sort((a, b) => b - a);
    let added = 0;
    for (const ln of sorted) {
        const idx = ln - 1;
        const line = linesArr[idx];
        const prev = linesArr[idx - 1] ?? "";
        if (prev.includes("@internal")) continue;
        const indent = (line.match(/^\s*/) ?? [""])[0];
        linesArr.splice(idx, 0, `${indent}/** @internal */`);
        added++;
    }
    if (added > 0) {
        writeFileSync(file, linesArr.join("\n"));
        totalAdded += added;
        totalFiles++;
        console.log(`  ${file}: +${added}`);
    }
}
console.log(`Added ${totalAdded} /** @internal */ tags across ${totalFiles} files.`);
