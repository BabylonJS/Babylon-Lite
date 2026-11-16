import { setDracoBaseUrl, setMeshoptBaseUrl } from "babylon-lite";

/** Resolve an asset beside a bundled demo while preserving the lab server's public asset route. */
export function demoAssetUrl(path: string, moduleUrl: string): string {
    const url = new URL(path, moduleUrl);
    url.pathname = url.pathname.replace("/lite/bundle/demos/", "/bundle/demos/");
    return url.href;
}

/**
 * Point the glTF decoders (Draco + meshopt) at the demo-local decoder files,
 * resolved relative to the calling demo module's URL. This keeps deployed demos
 * working under ANY base path (e.g. /lite-demos/) instead of fetching the
 * decoders from the site root. The explicit meshopt setter also stops the
 * bundler from constant-folding its `script.src` into a root-relative
 * `/meshopt_decoder.js` literal.
 */
export function configureDemoDecoderBases(moduleUrl: string): void {
    const base = demoAssetUrl("./", moduleUrl);
    setDracoBaseUrl(base);
    setMeshoptBaseUrl(base);
}
