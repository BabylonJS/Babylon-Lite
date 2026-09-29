import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { rollup, type OutputChunk, type Plugin } from "rollup";
import ts from "typescript";

import { ensureLibBuilt, isExternalRequest, LIB_ENTRY, PACKAGE_DIR } from "./bundler-harness";

const DTS_PATH = resolve(PACKAGE_DIR, "build/index.d.ts");
const VITE_JS = resolve(PACKAGE_DIR, "node_modules/vite/bin/vite.js");
const VIRTUAL_ENTRY = "\0domain-accessor-treeshake-entry";
const PUBLIC_DOMAIN_SYMBOLS = [
    "getMaterialSource",
    "isMaterialView",
    "getMaterialFamily",
    "getMaterialTextures",
    "getStandardEmissiveTexture",
    "getStandardBumpTexture",
    "getStandardSpecularTexture",
    "getStandardAmbientTexture",
    "getStandardLightmapTexture",
    "getStandardOpacityTexture",
    "getStandardReflectionTexture",
    "getStandardReflectionCubeTexture",
    "getPbrAlphaCutoff",
    "getPbrEmissiveColor",
    "getPbrMetallicReflectance",
    "getPbrClearCoat",
    "getPbrSheen",
    "getPbrIridescence",
    "getPbrAnisotropy",
    "getPbrSubsurface",
    "getPbrTransmission",
    "getPbrDispersion",
    "isPbrGammaAlbedo",
    "getPbrUnlit",
    "isPbrSkybox",
    "getShadowOnly",
    "hasMaterialUvTransform",
    "getShaderUniform",
    "getShaderTexture",
    "getTextureMetadata",
    "getTextureTransform",
    "setTextureTransform",
    "getTextureCoordinateIndex",
    "hasTextureTransform",
    "TextureMetadata",
    "TextureTransform",
    "TextureSamplerMetadata",
    "TextureCapabilities",
    "PbrShadowOnly",
] as const;

interface BundleSnapshot {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
    readonly chunks: readonly {
        readonly fileName: string;
        readonly code: string;
        readonly imports: readonly string[];
        readonly dynamicImports: readonly string[];
        readonly isEntry: boolean;
    }[];
}

function ensureDomainAccessorArtifacts(): void {
    const dist = spawnSync(process.execPath, [VITE_JS, "build", "--mode", "dist"], {
        cwd: PACKAGE_DIR,
        encoding: "utf-8",
    });
    if (dist.status !== 0) {
        throw new Error(`babylon-lite build (--mode dist) failed:\n${dist.stdout ?? ""}${dist.stderr ?? ""}`);
    }
    ensureLibBuilt();
}

async function bundleVirtualEntry(source: string): Promise<BundleSnapshot> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const virtualEntryPlugin: Plugin = {
        name: "domain-accessor-virtual-entry",
        resolveId(id) {
            return id === VIRTUAL_ENTRY ? VIRTUAL_ENTRY : null;
        },
        load(id) {
            return id === VIRTUAL_ENTRY ? source : null;
        },
    };
    let bundle: Awaited<ReturnType<typeof rollup>> | undefined;
    try {
        bundle = await rollup({
            input: VIRTUAL_ENTRY,
            external: (id: string) => isExternalRequest(id),
            treeshake: true,
            onwarn: (warning) => warnings.push(`[${warning.code}] ${warning.message}`),
            plugins: [virtualEntryPlugin],
        });
        const { output } = await bundle.generate({
            format: "es",
            entryFileNames: "entry.mjs",
            chunkFileNames: "[name]-[hash].mjs",
        });
        const chunks = output
            .filter((item): item is OutputChunk => item.type === "chunk")
            .map(({ fileName, code, imports, dynamicImports, isEntry }) => ({
                fileName,
                code,
                imports,
                dynamicImports,
                isEntry,
            }))
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        return { errors, warnings, chunks };
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { errors, warnings, chunks: [] };
    } finally {
        await bundle?.close();
    }
}

function getDeclarationName(statement: ts.Statement): string | undefined {
    if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
    ) {
        return statement.name?.text;
    }
    return undefined;
}

beforeAll(ensureDomainAccessorArtifacts, 300_000);

describe("domain accessor package isolation", () => {
    it("emits byte-identical code and no extra chunks when domain accessor imports are unused", async () => {
        const usedEntry = `import { createSceneContext } from ${JSON.stringify(LIB_ENTRY)};
console.log(createSceneContext);
`;
        const baseline = await bundleVirtualEntry(usedEntry);
        const withUnusedDomainImports = await bundleVirtualEntry(`import {
    getMaterialSource,
    getStandardEmissiveTexture,
    getPbrClearCoat,
    getShaderUniform,
    getTextureMetadata,
    getTextureTransform,
    setTextureTransform,
} from ${JSON.stringify(LIB_ENTRY)};
${usedEntry}`);

        expect(baseline.errors).toEqual([]);
        expect(baseline.warnings).toEqual([]);
        expect(withUnusedDomainImports.errors).toEqual([]);
        expect(withUnusedDomainImports.warnings).toEqual([]);
        expect(withUnusedDomainImports.chunks).toEqual(baseline.chunks);
        expect(withUnusedDomainImports.chunks.map(({ code }) => Buffer.byteLength(code))).toEqual(baseline.chunks.map(({ code }) => Buffer.byteLength(code)));
    }, 120_000);

    it("exports the domain API without Inspector vocabulary or metadata handle leaks", () => {
        const dts = readFileSync(DTS_PATH, "utf-8");
        const sourceFile = ts.createSourceFile(DTS_PATH, dts, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const declarations = new Map<string, string[]>();

        for (const statement of sourceFile.statements) {
            const name = getDeclarationName(statement);
            if (name && (PUBLIC_DOMAIN_SYMBOLS as readonly string[]).includes(name)) {
                const current = declarations.get(name) ?? [];
                current.push(statement.getText(sourceFile));
                declarations.set(name, current);
            }
        }

        expect([...declarations.keys()].sort()).toEqual([...PUBLIC_DOMAIN_SYMBOLS].sort());
        expect(dts).not.toMatch(/\b\w*Inspection\w*\b/);
        expect(dts).not.toMatch(/\bMaterialTextureBinding\w*\b/);
        expect(existsSync(resolve(PACKAGE_DIR, "build/lib/inspection"))).toBe(false);

        const metadataDeclarations = ["TextureMetadata", "TextureTransform", "TextureSamplerMetadata", "TextureCapabilities"]
            .flatMap((name) => declarations.get(name) ?? [])
            .join("\n");
        expect(metadataDeclarations).not.toMatch(/\b(?:GPUTexture|GPUTextureView|GPUSampler|GPUBuffer|GPUDevice)\b/);
        expect(metadataDeclarations).not.toMatch(/\b_[A-Za-z]\w*\b/);
        expect(metadataDeclarations).not.toMatch(/\b(?:label|section|propertyId|direction|mutation|state)\b/i);
    });
});
