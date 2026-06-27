import type { Awaitable } from "@better-auth/core";
import type { User } from "@better-auth/core/db";
import type { BetterFetchError } from "@better-fetch/fetch";

export type AuthUser = User & Record<string, any>;

/** Synchronous key/value store, typically keychain-backed. */
export type Storage = {
	getItem: (name: string) => unknown | null;
	setItem: (name: string, value: unknown) => void;
};

/** A single hit on the loopback listener, normalized across runtimes. */
export type LoopbackRequest = {
	path: string;
	query: Record<string, string>;
};

export type LoopbackResponse = {
	status: number;
	headers?: Record<string, string>;
	body: string;
};

export type LoopbackServer = {
	port: number;
	close: () => void;
};

/** Events the core pushes to the renderer through the adapter. */
export type AuthEvent =
	| { type: "authenticated"; user: AuthUser }
	| { type: "user-updated"; user: AuthUser | null }
	| { type: "error"; error: BetterFetchError | Error; path?: string };

/**
 * The only per-runtime surface. An adapter binds a 127.0.0.1 socket, opens the
 * system browser, pushes events to the renderer, and provides keychain storage;
 * the loopback flow itself lives in framework-agnostic core.
 */
export type DesktopAdapter = {
	openExternal: (url: string) => Awaitable<void>;
	serveLoopback: (
		onRequest: (req: LoopbackRequest) => Promise<LoopbackResponse>,
		opts?: { port?: number },
	) => Promise<LoopbackServer>;
	notifyRenderer: (event: AuthEvent) => void;
	storage: Storage;
};

/** Renderer-initiated sign-in request. `provider` is required for loopback. */
export type RequestAuthOptions = {
	provider: string;
	[key: string]: unknown;
};

export type DesktopClientOptions = {
	clientID?: string;
	/** Loopback path the browser is redirected back to. @default "/callback" */
	loopbackPath?: string;
	/** Fixed loopback port; omit to bind 127.0.0.1:0 (OS-assigned). */
	loopbackPort?: number;
	/** Milliseconds to keep the loopback open awaiting the redirect. @default 300000 */
	loopbackTimeout?: number;
	storagePrefix?: string;
	cookiePrefix?: string | string[];
	disableCache?: boolean;
	sanitizeUser?: (user: AuthUser) => Awaitable<AuthUser>;
	/**
	 * What the loopback shows after a successful exchange. A string is used as the
	 * HTML body; an object can redirect the browser to your own page instead.
	 * Defaults to a built-in "you can close this tab" page.
	 */
	loopbackSuccess?: string | { redirectTo: string };
};
