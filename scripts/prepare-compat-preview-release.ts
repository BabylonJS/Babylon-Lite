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
const DIST_PACKAGE_JSON = resolve(process.cwd(), "packages/babylon-lite-compat/dist/package.json");
const LITE_VERSION_ENV = process.env.LITE_VERSION;

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

function parseSemverCore(version: string, source: string): string {
    // Accept a semver core (x.y.z) with optional pre-release/build metadata and
    // normalize to the plain x.y.z core.
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
    if (!match) {
        throw new Error(`Unsupported ${source} '${version}'. Expected x.y.z (optionally with pre-release/build metadata).`);
    }
    return `${match[1]}.${match[2]}.${match[3]}`;
}

function resolveLiteBaseVersion(): string {
    if (!LITE_VERSION_ENV || LITE_VERSION_ENV.trim() === "") {
        throw new Error("LITE_VERSION must be set to the @babylonjs/lite version resolved earlier in the publish pipeline.");
    }
    return parseSemverCore(LITE_VERSION_ENV.trim(), "LITE_VERSION");
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

const liteBaseVersion = resolveLiteBaseVersion();
const previewVersion = `${liteBaseVersion}-preview`;

if (isVersionPublished(previewVersion)) {
    throw new Error(`${PACKAGE_NAME}@${previewVersion} is already published. Refusing to overwrite an existing npm version.`);
}

pkg.version = previewVersion;
pkg.babylonLiteRelease = {
    ...(process.env.BUILD_BUILDID ? { azureBuildId: process.env.BUILD_BUILDID } : {}),
    ...(process.env.BUILD_SOURCEVERSION ? { sourceVersion: process.env.BUILD_SOURCEVERSION } : {}),
    builtAgainstLite: liteBaseVersion,
};
writeFileSync(DIST_PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Package: ${PACKAGE_NAME}`);
console.log(`Base @babylonjs/lite version: ${liteBaseVersion}`);
console.log(`Preview version: ${previewVersion}`);
console.log(`Built against @babylonjs/lite: ${liteBaseVersion}`);
console.log(`##vso[task.setvariable variable=PACKAGE_NAME_COMPAT]${PACKAGE_NAME}`);
console.log(`##vso[task.setvariable variable=PACKAGE_VERSION_COMPAT]${previewVersion}`);
