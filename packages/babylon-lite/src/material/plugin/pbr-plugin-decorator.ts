import type { PbrExt } from "../pbr/pbr-flags.js";

/** @internal Optional pass/resource policy installed by a material feature. */
export let pbrPluginDecorator: ((extension: PbrExt) => PbrExt) | null = null;

/** @internal Ordinary material plugins retain their original bridge when unused. */
export function installPbrPluginDecorator(decorator: NonNullable<typeof pbrPluginDecorator>): void {
    pbrPluginDecorator = decorator;
}
