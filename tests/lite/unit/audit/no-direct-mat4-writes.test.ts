/**
 * Audit: no direct mat4 GPU writes outside the F32 packer boundary.
 *
 * After HPM Phase 3 every M0-scope mat4 GPU upload is routed through
 * `packages/babylon-lite/src/math/pack-mat4-into-f32.ts`. This audit defends
 * that boundary in CI: any new `.set(<matrix>, <offset>)` or matrix-named
 * `device.queue.writeBuffer(...)` outside the explicit allowlist fails the
 * unit suite immediately, before parity / bundle-size signals can mask the
 * regression.
 *
 * The audit uses a conservative line-by-line regex. False positives are
 * resolved by extending the allowlist with a comment explaining WHY the file
 * (or specific `file:line`) is deferred. Each allowlist entry must carry a
 * follow-up reference (architecture D4 or M0-followup) so reviewers can audit
 * the suppression list trivially.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..", "..", "..", "packages", "babylon-lite", "src");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Files (relative to repo root) skipped in their entirety. Each entry MUST
 *  have a justification comment referencing architecture D4 (deferred at M0)
 *  or another tracked follow-up. */
const FILE_ALLOWLIST = new Set<string>([
    // The F32 packer itself owns the boundary — its `.set(...)` calls are the
    // canonical implementation, not a violation.
    "packages/babylon-lite/src/math/pack-mat4-into-f32.ts",

    // Deferred per architecture D4 (M0-followup):
    //   GPU picker still writes mesh world matrices via `_uboF32.set(mesh.worldMatrix)`.
    //   TODO(HPM-followup): route through packMat4IntoF32.
    "packages/babylon-lite/src/picking/gpu-picker.ts",

    // Deferred per architecture D4 (M0-followup):
    //   Skybox loader path — no current direct mat4 writes match the regex,
    //   but allowlisted wholesale so any future refactor stays opt-in until
    //   a follow-up sweep routes it through the packer.
    "packages/babylon-lite/src/loader-skybox/load-skybox.ts",
    "packages/babylon-lite/src/loader-skybox/skybox-renderable.ts",

    // Deferred per architecture D4 (M0-followup):
    //   Gaussian splatting pipelines maintain their own F32 CPU staging
    //   buffers and write world matrices directly via `cpu.set(world, 0)`.
    //   TODO(HPM-followup): route through packMat4IntoF32 once GS storage
    //   buffer layouts are reconciled with the opaque Mat4 substrate.
    "packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-mesh.ts",
    "packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts",
    "packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-pipeline-sh.ts",
    "packages/babylon-lite/src/picking/gs-picking-pipeline.ts",

    // Deferred per architecture D4 (M0-followup):
    //   Background materials (DDS / HDR / solid / ground skyboxes) still
    //   `data.set(world, 0)` directly into their per-material UBO scratch.
    //   TODO(HPM-followup): widen background world handling through packer.
    "packages/babylon-lite/src/material/pbr/background-dds-skybox.ts",
    "packages/babylon-lite/src/material/pbr/background-ground.ts",
    "packages/babylon-lite/src/material/pbr/background-hdr-skybox.ts",
    "packages/babylon-lite/src/material/pbr/background-solid-skybox.ts",
]);

/** Line-level allowlist `relPath:lineNumber` for specific lines that are
 *  *correct* under the substrate (e.g. F32 destination + opaque Mat4 source
 *  where `.set()` is an in-spec downcast equivalent to packMat4IntoF32 for
 *  the simple length-16 case). Adding to this list requires the same
 *  justification standard as FILE_ALLOWLIST. */
const LINE_ALLOWLIST = new Set<string>([
    // `scene-uniforms.ts` receives pre-packed Float32Array view/viewProj
    // matrices from upstream callers that already routed through the packer.
    // The `.set(...)` here is an F32->F32 byte copy, not an opaque Mat4 write.
    "packages/babylon-lite/src/material/scene-uniforms.ts:21",
    "packages/babylon-lite/src/material/scene-uniforms.ts:22",

    // `addThinInstance` seeds the per-mesh F32 capacity buffer from an opaque
    // Mat4. `.set(matrix, 0)` performs an in-spec element-wise downcast that
    // produces the same F32 bytes packMat4IntoF32 would write for offset 0.
    // TODO(HPM-followup): collapse into packMat4IntoF32 to fully retire the
    // opaque-Mat4-as-array-like dependency.
    "packages/babylon-lite/src/mesh/thin-instance.ts:108",
]);

/** Variable-name heuristic: matrix-like identifiers. */
const MATRIX_NAME_RE = /(world|matrix|mat4|wm|proj|view)/i;

/** Walk `dir` recursively yielding absolute paths to `.ts` files (excluding
 *  test/spec/declaration files, build output, and node_modules). */
function* walkTs(dir: string): Generator<string> {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
        const abs = join(dir, name);
        const s = statSync(abs);
        if (s.isDirectory()) {
            if (name === "node_modules" || name === "dist" || name === "build" || name === "__generated__") {
                continue;
            }
            yield* walkTs(abs);
        } else if (s.isFile()) {
            if (!name.endsWith(".ts")) {
                continue;
            }
            if (name.endsWith(".test.ts") || name.endsWith(".spec.ts") || name.endsWith(".d.ts")) {
                continue;
            }
            yield abs;
        }
    }
}

interface Violation {
    relPath: string;
    line: number;
    snippet: string;
}

function relFromRepoRoot(abs: string): string {
    return relative(REPO_ROOT, abs).split(sep).join("/");
}

function scanFile(abs: string, relPath: string): Violation[] {
    const text = readFileSync(abs, "utf-8");
    const lines = text.split(/\r?\n/);
    const violations: Violation[] = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const stripped = raw.replace(/\/\/.*$/, "");
        // Pattern 1: `<dst>.set(<name>, <integer-offset>)` where <name> looks matrix-like.
        const setRe = /\.set\(\s*([A-Za-z_$][\w$]*)\s*,\s*\d+\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = setRe.exec(stripped)) !== null) {
            const name = m[1]!;
            if (!MATRIX_NAME_RE.test(name)) {
                continue;
            }
            violations.push({ relPath, line: i + 1, snippet: raw.trim() });
        }
        // Pattern 2: `device.queue.writeBuffer(<buf>, <off>, <name>)` where <name> looks matrix-like.
        const wbRe = /\bwriteBuffer\s*\(\s*[^,]+,\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
        while ((m = wbRe.exec(stripped)) !== null) {
            const name = m[1]!;
            if (!MATRIX_NAME_RE.test(name)) {
                continue;
            }
            violations.push({ relPath, line: i + 1, snippet: raw.trim() });
        }
    }
    return violations;
}

describe("audit: no direct mat4 GPU writes outside allowlist", () => {
    it("every direct mat4 write in packages/babylon-lite/src is in the allowlist", () => {
        const violations: Violation[] = [];
        for (const abs of walkTs(SRC_ROOT)) {
            const relPath = relFromRepoRoot(abs);
            if (FILE_ALLOWLIST.has(relPath)) {
                continue;
            }
            const fileViolations = scanFile(abs, relPath).filter((v) => !LINE_ALLOWLIST.has(`${v.relPath}:${v.line}`));
            violations.push(...fileViolations);
        }
        if (violations.length > 0) {
            const msg = violations.map((v) => `  ${v.relPath}:${v.line}: ${v.snippet}`).join("\n");
            throw new Error(
                `Found ${violations.length} direct mat4 GPU write(s) outside the allowlist.\n` +
                    `Route the write through packMat4IntoF32, or add the file/line to the audit allowlist with a justification comment.\n\n` +
                    msg
            );
        }
        expect(violations).toEqual([]);
    });
});
