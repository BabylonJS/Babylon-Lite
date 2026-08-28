/** Resolve an asset beside a bundled demo while preserving the lab server's public asset route. */
export function demoAssetUrl(path: string, moduleUrl: string): string {
    const url = new URL(path, moduleUrl);
    url.pathname = url.pathname.replace("/lite/bundle/demos/", "/bundle/demos/");
    return url.href;
}
