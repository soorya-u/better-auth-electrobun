/**
 * Cross-domain web client plugin — the counterpart to `electrobunProxyClient`
 * (same-origin cookie flow). Exposes `authClient.electrobun.forwardCallback()`,
 * which forwards the OAuth token fragment to the desktop app's protocol scheme.
 */
import type { BetterAuthClientPlugin } from "@better-auth/core";
import { parseProtocolScheme } from "./utils";
import { PACKAGE_VERSION } from "./version";

// The package compiles without the DOM lib, so type the bit of `window` we use.
declare const window:
	| { location: { hash: string; replace: (url: string) => void } }
	| undefined;

export type ElectrobunCallbackClientOptions = {
	/** The desktop app's protocol scheme, e.g. "dev.acme.app". */
	protocol: string | { scheme: string };
	/** @default "/auth/callback" */
	callbackPath?: string;
	/** Must match the server plugin's `callback.hashKey`. @default "token" */
	hashKey?: string;
};

export const electrobunCallbackClient = (
	options: ElectrobunCallbackClientOptions,
) => {
	const { scheme } = parseProtocolScheme(options.protocol);
	const callbackPath = options.callbackPath ?? "/auth/callback";
	const hashKey = options.hashKey ?? "token";

	return {
		id: "electrobun-callback",
		version: PACKAGE_VERSION,
		getActions: () => ({
			electrobun: {
				/** Forwards the OAuth token fragment to the desktop protocol scheme. */
				forwardCallback: (): boolean => {
					if (typeof window === "undefined" || !window) return false;
					const hash = window.location.hash;
					if (!hash.startsWith(`#${hashKey}=`)) return false;
					window.location.replace(`${scheme}:/${callbackPath}${hash}`);
					return true;
				},
			},
		}),
		$InferServerPlugin: {} as never,
	} satisfies BetterAuthClientPlugin;
};
