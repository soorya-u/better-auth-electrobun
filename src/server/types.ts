import type { AllowedLoopbackPorts } from "../core/loopback";

export type DesktopServerOptions = {
	/**
	 * Client ID used to identify the desktop client during authorization. Must
	 * match the `clientID` configured in the desktop adapter.
	 * @default "desktop"
	 */
	clientID?: string;
	/**
	 * Duration (in seconds) for which the one-time authorization code is valid.
	 * @default 300
	 */
	codeExpiresIn?: number;
	/**
	 * Disable rewriting the request `origin` from the `desktop-origin` header.
	 * @default false
	 */
	disableOriginOverride?: boolean;
	/**
	 * Name of the one-time-code query/hash parameter appended to the loopback or
	 * web-callback URL.
	 * @default "token"
	 */
	hashKey?: string;
	/**
	 * Optional branded web callback page. When set, `oauth-complete` redirects the
	 * browser here (`#token=…&loopback=…`) instead of straight to the loopback,
	 * and the page must call `forwardToDesktop()` to complete the hand-off.
	 * Leave unset for the default direct-to-loopback redirect.
	 */
	webCallbackUrl?: string;
	/**
	 * Optional hardening: restrict the loopback port the server is willing to
	 * redirect to. Either an explicit allowlist or an inclusive `{ min, max }`
	 * range. Omit to allow any ephemeral port.
	 */
	allowedLoopbackPorts?: AllowedLoopbackPorts;
};

// Resolved (defaults-applied) options shared by the server endpoints.
export type ResolvedServerOptions = {
	clientID: string;
	codeExpiresIn: number;
	hashKey: string;
	webCallbackUrl?: string;
	allowedLoopbackPorts?: AllowedLoopbackPorts;
};
