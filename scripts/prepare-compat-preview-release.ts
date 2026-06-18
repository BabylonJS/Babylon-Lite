/// <reference types="node" />

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

type PublishPackageJson = {
    name?: string;
    version?: string;
    babylonLiteRelease?: {
        azureBuildId?: string;
        sourceVersion?: string;
        builtAgainstLite?: string;
    };
};

const PACKAGE_NAME = "@babylonjs/lite-compat";
const PREVIEW_DIST_TAG = "preview";
const DIST_PACKAGE_JSON = resolve(process.cwd(), "packages/babylon-lite-compat/dist/package.json");

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): string {
    try {
        return execFileSync(command, args, {
            cwd: process.cwd(),
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        if (options.allowFailure) {
            return "";
        }
        throw error;
    }
}

function parseBaseVersion(version: string): string {
    // Accept a plain semver core (x.y.z); strip any pre-existing pre-release/build
    // metadata so we always append a fresh preview suffix.
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match) {
        throw new Error(`Unsupported base version '${version}'. Expected x.y.z.`);
    }
    return `${match[1]}.${match[2]}.${match[3]}`;
}

function previewSuffix(): string {
    const buildId = process.env.BUILD_BUILDID;
    if (buildId && /^\d+$/.test(buildId)) {
        return buildId;
    }
    // Local / non-Azure fallback: compact UTC timestamp (YYYYMMDDHHmmss).
    return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function isVersionPublished(version: string): boolean {
    return run("npm", ["view", `${PACKAGE_NAME}@${version}`, "version", "--registry", "https://registry.npmjs.org/"], { allowFailure: true }) === version;
}

const pkg = JSON.parse(readFileSync(DIST_PACKAGE_JSON, "utf-8")) as PublishPackageJson;

if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`Refusing to publish '${pkg.name ?? "<missing>"}'. Expected '${PACKAGE_NAME}'.`);
}

if (!pkg.version) {
    throw new Error(`${DIST_PACKAGE_JSON} does not contain a version.`);
}

const baseVersion = parseBaseVersion(pkg.version);
const previewVersion = `${baseVersion}-preview.${previewSuffix()}`;

if (isVersionPublished(previewVersion)) {
    throw new Error(`${PACKAGE_NAME}@${previewVersion} is already published. Refusing to overwrite an existing npm version.`);
}

pkg.version = previewVersion;
pkg.babylonLiteRelease = {
    ...(process.env.BUILD_BUILDID ? { azureBuildId: process.env.BUILD_BUILDID } : {}),
    ...(process.env.BUILD_SOURCEVERSION ? { sourceVersion: process.env.BUILD_SOURCEVERSION } : {}),
    ...(process.env.LITE_VERSION ? { builtAgainstLite: process.env.LITE_VERSION } : {}),
};
writeFileSync(DIST_PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Package: ${PACKAGE_NAME}`);
console.log(`Base version: ${baseVersion}`);
console.log(`Preview version: ${previewVersion}`);
console.log(`Dist tag: ${PREVIEW_DIST_TAG}`);
if (process.env.LITE_VERSION) {
    console.log(`Built against @babylonjs/lite: ${process.env.LITE_VERSION}`);
}
console.log(`##vso[task.setvariable variable=PACKAGE_NAME_COMPAT]${PACKAGE_NAME}`);
console.log(`##vso[task.setvariable variable=PACKAGE_VERSION_COMPAT]${previewVersion}`);
console.log(`##vso[task.setvariable variable=PACKAGE_DIST_TAG_COMPAT]${PREVIEW_DIST_TAG}`);
