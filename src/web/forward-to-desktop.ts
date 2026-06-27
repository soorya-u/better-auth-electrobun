import type { BetterAuthClientPlugin } from "@better-auth/core";
import { parseLoopbackUrl } from "../core/loopback";
import { PACKAGE_VERSION } from "../version";

// The package compiles without the DOM lib; type just the bit of `window` we use.
declare const window:
	| { location: { hash: string; replace: (url: string) => void } }
	| undefined;

export type ForwardToDesktopOptions = {
	/** Must match the server plugin's `hashKey`. @default "token" */
	hashKey?: string;
};

/**
 * Opt-in successor to the old scheme-based `forwardCallback`. On a branded
 * `webCallbackUrl` page, reads `#token=…&loopback=…` from the fragment and
 * performs a **top-level navigation** to the desktop loopback
 * (`http://127.0.0.1:<port>/…?token=…`) — no CORS / PNA / mixed-content.
 *
 * Returns `false` (a no-op) outside a browser or when the fragment is absent,
 * so it is safe to call unconditionally on the callback page.
 */
export function forwardToDesktop(options?: ForwardToDesktopOptions): boolean {
	if (typeof window === "undefined" || !window) return false;
	const hashKey = options?.hashKey ?? "token";

	const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
	const token = params.get(hashKey);
	const loopback = params.get("loopback");
	if (!token || !loopback) return false;

	const target = parseLoopbackUrl(decodeURIComponent(loopback));
	if (!target) return false;

	target.searchParams.set(hashKey, token);
	window.location.replace(target.toString());
	return true;
}

/**
 * Better Auth client plugin wrapping {@link forwardToDesktop}, for consumers
 * that prefer the `createAuthClient({ plugins: [...] })` pattern:
 *
 * ```ts
 * const authClient = createAuthClient({ plugins: [webDesktop()] });
 * authClient.forwardToDesktop();
 * ```
 */
export const webDesktop = (options?: ForwardToDesktopOptions) =>
	({
		id: "desktop-web",
		version: PACKAGE_VERSION,
		getActions: () => ({
			forwardToDesktop: () => forwardToDesktop(options),
		}),
	}) satisfies BetterAuthClientPlugin;
