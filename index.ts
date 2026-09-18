import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activate, type PiExtensionAPI } from "./src/pi/extension.ts";

/**
 * Pi Universal Harness — extension entry point.
 *
 * Pi's subdirectory-extension loader looks for `index.ts` at the directory root, so
 * this file is the symlink target that `scripts/install.sh` places in
 * `<config>/agent/extensions/pi-universal-harness`.
 *
 * All real work lives in `src/`. This file exists to keep the Pi-facing contract in
 * one obvious place and to be the only file that imports Pi's own types, so the rest
 * of the harness stays testable without Pi installed.
 */
export default function (pi: ExtensionAPI): void {
	activate(pi as unknown as PiExtensionAPI);
}
