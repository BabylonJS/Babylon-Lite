/**
 * Bundle Analyzer — builds a single scene with rollup-plugin-visualizer
 * to produce a per-module size breakdown.
 *
 * Usage:
 *   npx tsx scripts/analyze-bundle.ts scene7
 *   npx tsx scripts/analyze-bundle.ts scene1
 *   BUNDLE_SCENES=scene7 npx tsx scripts/analyze-bundle.ts
 *
 * Output: prints a per-chunk, per-module size table sorted by size.
 * Also writes /tmp/<scene>-bundle-stats.html (interactive treemap).
 */
import { build } from "vite";
import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const labDir = resolve(ROOT, "lab");

const scene = process.argv[2] || process.env.BUNDLE_SCENES || "scene7";

interface TreeNode {
    name: string;
    uid?: string;
    children?: TreeNode[];
}

interface NodePart {
    renderedLength: number;
    gzipLength: number;
    metaUid: string;
}

interface NodeMeta {
    id: string;
    moduleParts: Record<string, string>;
}

interface StatsData {
    tree: TreeNode;
    nodeParts: Record<string, NodePart>;
    nodeMetas: Record<string, NodeMeta>;
}

interface ModuleInfo {
    id: string;
    size: number;
    gzip: number;
}

function collectLeaves(node: TreeNode, leaves: { uid: string; path: string[] }[], path: string[]): void {
    const cur = [...path, node.name];
    if (node.uid) {
        leaves.push({ uid: node.uid, path: cur });
    }
    if (node.children) {
        for (const child of node.children) {
            collectLeaves(child, leaves, cur);
        }
    }
}

async function main(): Promise<void> {
    // Dynamic import — rollup-plugin-visualizer is ESM-only
    const { visualizer } = await import("rollup-plugin-visualizer");

    const jsonPath = `/tmp/${scene}-bundle-stats.json`;
    const htmlPath = `/tmp/${scene}-bundle-stats.html`;

    // Build with raw-data output for programmatic analysis
    await build({
        root: labDir,
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        plugins: [
            visualizer({
                filename: jsonPath,
                template: "raw-data",
                gzipSize: true,
            }),
            visualizer({
                filename: htmlPath,
                template: "treemap",
                gzipSize: true,
            }),
        ],
        build: {
            outDir: `/tmp/${scene}-analyze`,
            emptyOutDir: true,
            minify: "esbuild",
            sourcemap: false,
            modulePreload: false,
            rollupOptions: {
                input: { [scene]: resolve(labDir, `lite/src/lite/${scene}.ts`) },
                output: {
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: `${scene}-[name]-[hash].js`,
                },
            },
        },
    });

    // Parse and print summary
    const data: StatsData = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const { tree, nodeParts, nodeMetas } = data;

    // Group modules by chunk (depth-1 children of root)
    let grandTotal = 0;
    for (const chunkNode of tree.children || []) {
        const leaves: { uid: string; path: string[] }[] = [];
        collectLeaves(chunkNode, leaves, []);

        const modules: ModuleInfo[] = [];
        for (const leaf of leaves) {
            const part = nodeParts[leaf.uid];
            if (!part) continue;
            const meta = nodeMetas[part.metaUid];
            const id = meta?.id || leaf.path.join("/");
            modules.push({ id, size: part.renderedLength, gzip: part.gzipLength });
        }
        modules.sort((a, b) => b.size - a.size);

        const totalSize = modules.reduce((s, m) => s + m.size, 0);
        const totalGzip = modules.reduce((s, m) => s + m.gzip, 0);
        grandTotal += totalSize;
        console.log(`\n=== ${chunkNode.name} (${(totalSize / 1024).toFixed(1)} KB rendered, ${(totalGzip / 1024).toFixed(1)} KB gzip) ===`);
        for (const m of modules.slice(0, 40)) {
            const shortPath = m.id
                .replace(/.*packages\/babylon-lite\/src\//, "src/")
                .replace(/.*node_modules\//, "nm:")
                .replace(/.*lab\//, "lab/");
            console.log(`  ${String(m.size).padStart(6)} B  ${String(m.gzip).padStart(5)} gz  ${shortPath}`);
        }
        if (modules.length > 40) {
            const rest = modules.slice(40);
            const restSize = rest.reduce((s, m) => s + m.size, 0);
            console.log(`  ... +${rest.length} more modules (${(restSize / 1024).toFixed(1)} KB)`);
        }
    }
    console.log(`\nTotal source size across all chunks: ${(grandTotal / 1024).toFixed(1)} KB`);
    console.log(`Interactive treemap: ${htmlPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
