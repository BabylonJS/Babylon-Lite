/**
 * Compat-layer sync — shared GitHub auth helper.
 *
 * Resolves a usable GitHub token for the compat-sync pipeline scripts
 * (`open-compat-sync-pr.ts` and `check-open-compat-sync-pr.ts`) so they stay
 * consistent and there is exactly one place that knows how to authenticate.
 *
 * Auth resolution (provide EITHER a GitHub App OR a PAT):
 *   - GH_APP_ID + GH_APP_PRIVATE_KEY → mint a short-lived **GitHub App
 *     installation token** scoped to the repo. PRs opened with it are authored by
 *     the app's bot identity (`<app>[bot]`), so a human (even the pipeline owner)
 *     can review/approve them. Preferred path. GH_APP_PRIVATE_KEY MUST be the App's
 *     `.pem` file base64-encoded as a single line (base64 is the only format that
 *     survives CI secret stores without newline mangling). Produce it with:
 *       PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("app.pem"))
 *       bash:       base64 -w0 app.pem
 *   - GITHUB_TOKEN → fallback PAT. PRs opened with it are authored by the PAT's
 *     owner, who then cannot review their own PR.
 *
 * Every secret the resolver touches (PAT, private key, minted token) is returned
 * in `secrets` so callers can redact them from logs via `makeRedactor`.
 *
 * Callers pass a least-privilege `access` level ("read" for the guard, "write" for
 * the PR driver) so the minted App token only carries the permissions that script
 * actually needs.
 */

import { createSign } from "crypto";

/** Access level for a minted GitHub App installation token (least-privilege). */
export type TokenAccess = "read" | "write";

export interface ResolvedToken {
    /** Bearer token usable for `git push` and the GitHub REST API. */
    token: string;
    /** Secret strings to redact from any log/error output. */
    secrets: string[];
    /** Human-readable description of which auth path was used. */
    source: string;
}

/**
 * Resolve the GitHub token for `repo` ("owner/name"). Uses a GitHub App
 * installation token when GH_APP_ID/GH_APP_PRIVATE_KEY are configured, otherwise
 * the GITHUB_TOKEN PAT. Throws if neither is available.
 *
 * `access` requests least-privilege permissions on the minted App token: "read"
 * (PR metadata only — for the preflight guard) or "write" (contents + PRs + issues —
 * for the PR driver that pushes a branch and opens/labels a PR). It only affects the
 * App path; a fallback PAT carries whatever scope it was created with.
 */
export async function resolveGithubToken(repo: string, access: TokenAccess = "write"): Promise<ResolvedToken> {
    const appId = cleanEnv(process.env.GH_APP_ID);
    const privateKeyRaw = cleanEnv(process.env.GH_APP_PRIVATE_KEY);
    const secrets: string[] = [];

    if (appId && privateKeyRaw) {
        const privateKey = decodePrivateKey(privateKeyRaw);
        secrets.push(privateKey);
        const token = await mintInstallationToken(appId, privateKey, repo, access);
        secrets.push(token);
        return {
            token,
            secrets,
            source: `GitHub App installation token, ${access}-scoped (PRs authored by the app bot, reviewable)`,
        };
    }

    const pat = cleanEnv(process.env.GITHUB_TOKEN);
    if (!pat) {
        throw new Error("No GitHub auth configured: set GH_APP_ID + GH_APP_PRIVATE_KEY (preferred) or GITHUB_TOKEN.");
    }
    secrets.push(pat);
    return {
        token: pat,
        secrets,
        source: "GITHUB_TOKEN PAT (no GitHub App configured; PRs authored by the PAT owner)",
    };
}

/** Build a redactor that strips every provided secret from a string before logging. */
export function makeRedactor(secrets: string[]): (text: string) => string {
    return (text: string): string => {
        let out = text;
        for (const secret of secrets) {
            if (secret) {
                out = out.split(secret).join("***");
            }
        }
        return out;
    };
}

/** Common headers for GitHub API calls authenticated with the given bearer token. */
export function githubHeaders(bearer: string): Record<string, string> {
    return {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "compat-sync-pipeline",
    };
}

/**
 * Read an env var, treating empty/whitespace AND an un-substituted ADO macro
 * (e.g. the literal `$(GH_APP_ID)` left behind when a pipeline variable is not
 * defined) as "unset". Returns the trimmed value or undefined.
 */
export function cleanEnv(raw: string | undefined): string | undefined {
    const value = raw?.trim();
    if (!value || /^\$\([^)]*\)$/.test(value)) {
        return undefined;
    }
    return value;
}

/**
 * Decode the GitHub App private key. `GH_APP_PRIVATE_KEY` MUST be the App's `.pem`
 * file base64-encoded as a single line — this is the only supported format because
 * it is the only one that survives CI secret stores intact (a raw multi-line PEM
 * gets its newlines mangled, which corrupts the key and yields the cryptic OpenSSL
 * `DECODER routines::unsupported` error at sign time).
 *
 * To produce the value:
 *   - PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("app.pem"))
 *   - bash:       base64 -w0 app.pem
 *
 * Throws a clear, actionable error if the value is not base64 that decodes to a PEM
 * private key.
 */
function decodePrivateKey(raw: string): string {
    const value = raw.trim();
    const bad = (why: string): never => {
        throw new Error(
            `GH_APP_PRIVATE_KEY ${why}. It must be the App's .pem file base64-encoded as a single line, e.g. ` +
                `PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("app.pem")) — or bash: base64 -w0 app.pem`
        );
    };

    if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
        bad("is not valid single-line base64 (it contains non-base64 characters — did you paste the raw PEM instead?)");
    }
    let decoded: string;
    try {
        decoded = Buffer.from(value, "base64").toString("utf8");
    } catch {
        return bad("could not be base64-decoded");
    }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(decoded) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(decoded)) {
        bad("did not base64-decode to a PEM private key");
    }
    return decoded;
}

/** Base64url-encode a string or buffer (no padding), per the JWT spec. */
function base64url(input: string | Buffer): string {
    return Buffer.from(input).toString("base64url");
}

/** Build a short-lived (≤10 min) RS256 JWT used to authenticate AS the GitHub App. */
function makeAppJwt(appId: string, privateKey: string): string {
    const now = Math.floor(Date.now() / 1000);
    // `iat` is back-dated 60s to tolerate minor clock skew between us and GitHub.
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    let signature: string;
    try {
        signature = signer.sign(privateKey).toString("base64url");
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to sign the GitHub App JWT — GH_APP_PRIVATE_KEY decoded but is not a usable RSA private key (${detail}). ` +
                "Verify the base64 was produced from the App's full .pem (PKCS#1 or PKCS#8), not a passphrase-protected or truncated key."
        );
    }
    return `${signingInput}.${signature}`;
}

/**
 * Exchange the App's private key for an installation access token scoped to `repo`.
 * Discovers the installation id from the repo automatically (so no separate
 * installation-id secret is needed), then requests a token restricted to that one
 * repository with least-privilege permissions: "read" grants `pull_requests: read`
 * (all the preflight guard needs); "write" grants `contents`/`pull_requests`/`issues`
 * write (what the PR driver needs to push a branch and open/label a PR).
 */
async function mintInstallationToken(appId: string, privateKey: string, repo: string, access: TokenAccess): Promise<string> {
    const jwt = makeAppJwt(appId, privateKey);

    const instResponse = await fetch(`https://api.github.com/repos/${repo}/installation`, {
        headers: githubHeaders(jwt),
    });
    if (!instResponse.ok) {
        throw new Error(`Failed to find the GitHub App installation on ${repo} (${instResponse.status}): ${await instResponse.text()}. Is the App installed on this repo?`);
    }
    const installation = (await instResponse.json()) as { id?: number };
    if (!installation.id) {
        throw new Error(`GitHub App installation lookup for ${repo} returned no id.`);
    }

    const permissions = access === "read" ? { pull_requests: "read" } : { contents: "write", pull_requests: "write", issues: "write" };
    const [owner, name] = repo.split("/");
    const tokenResponse = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
        method: "POST",
        headers: { ...githubHeaders(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({
            repositories: name ? [name] : undefined,
            permissions,
        }),
    });
    if (!tokenResponse.ok) {
        throw new Error(`Failed to mint an installation token for ${owner}/${name} (${tokenResponse.status}): ${await tokenResponse.text()}`);
    }
    const minted = (await tokenResponse.json()) as { token?: string };
    if (!minted.token) {
        throw new Error("GitHub App token exchange returned no token.");
    }
    return minted.token;
}
