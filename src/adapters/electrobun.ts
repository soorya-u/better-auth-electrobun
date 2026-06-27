import type {
	BetterAuthClientOptions,
	BetterAuthClientPlugin,
	ClientStore,
} from "@better-auth/core";
import type { BetterFetch } from "@better-fetch/fetch";
import { BrowserView, Utils } from "electrobun/bun";
import {
	createDesktopCookieLayer,
	type DesktopClientPluginOptions,
} from "../core/client";
import { startAuthFlow } from "../core/exchange";
import type {
	AuthEvent,
	AuthUser,
	DesktopAdapter,
	RequestAuthOptions,
	Storage,
} from "../core/types";
import { fetchUserImage } from "../core/user";
import type { AuthBunRequests, DesktopAuthRPC } from "../rpc/schema";
import { PACKAGE_VERSION } from "../version";

// Bun keychain storage (Bun.secrets), re-exported so electrobun consumers can
// pass it explicitly as `storage`.
export {
	type KeychainStorageOptions,
	keychainStorage,
} from "../core/storage";

type AuthSender = {
	onAuthenticated(user: AuthUser): void;
	onUserUpdated(user: AuthUser | null): void;
	onAuthError(payload: { error: { message: string }; path?: string }): void;
};

export type ElectrobunDesktopRPC = {
	send: AuthSender;
	setTransport(transport: unknown): void;
};

export type ElectrobunDesktopOptions = DesktopClientPluginOptions;

function createLoopbackAdapter(
	getSender: () => AuthSender | null,
	storage: Storage,
): DesktopAdapter {
	return {
		openExternal(url) {
			const ok = Utils.openExternal(url);
			if (!ok) throw new Error(`Failed to open the system browser: ${url}`);
		},
		async serveLoopback(onRequest, opts) {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: opts?.port ?? 0,
				async fetch(req) {
					const url = new URL(req.url);
					const query: Record<string, string> = {};
					url.searchParams.forEach((value, key) => {
						query[key] = value;
					});
					const res = await onRequest({ path: url.pathname, query });
					return new Response(res.body, {
						status: res.status,
						headers: res.headers,
					});
				},
			});
			// Graceful stop so the in-flight success response flushes before close.
			return { port: server.port ?? 0, close: () => void server.stop() };
		},
		notifyRenderer(event: AuthEvent) {
			const send = getSender();
			if (!send) return;
			switch (event.type) {
				case "authenticated":
					send.onAuthenticated(event.user);
					break;
				case "user-updated":
					send.onUserUpdated(event.user);
					break;
				case "error":
					send.onAuthError({
						error: { message: event.error.message },
						path: event.path,
					});
					break;
			}
		},
		storage,
	};
}

/**
 * Better Auth client plugin for Electrobun (Bun main process). Use it with
 * `createAuthClient`, then pass `createBunRPC()` to your `BrowserWindow` and
 * call `setupMain()`:
 *
 * ```ts
 * const authClient = createAuthClient({
 *   baseURL,
 *   plugins: [electrobunDesktop({ clientID, storage: await keychainStorage() })],
 * });
 * new BrowserWindow({ rpc: authClient.createBunRPC(), url });
 * await authClient.setupMain();
 * ```
 */
export const electrobunDesktop = (options: ElectrobunDesktopOptions) => {
	const layer = createDesktopCookieLayer(options);
	// The RPC object returned by defineRPC is itself the renderer channel; capture
	// it so the adapter can push events without reaching through the BrowserWindow.
	let rpc: ElectrobunDesktopRPC | null = null;
	const adapter = createLoopbackAdapter(
		() => rpc?.send ?? null,
		options.storage,
	);

	const sanitizeUser = async (
		user: AuthUser | null,
	): Promise<AuthUser | null> => {
		if (user !== null && typeof options.sanitizeUser === "function") {
			try {
				return await options.sanitizeUser(user);
			} catch (error) {
				console.error("Error while sanitizing user", error);
				return null;
			}
		}
		return user;
	};

	return {
		id: "desktop",
		version: PACKAGE_VERSION,
		fetchPlugins: [layer.fetchPlugin],
		getActions: (
			$fetch: BetterFetch,
			$store: ClientStore,
			clientOptions: BetterAuthClientOptions | undefined,
		) => {
			layer.bindStore($store);
			layer.bindServerOrigin(clientOptions?.baseURL);
			const getCookie = layer.getCookie;

			const requests: {
				[K in keyof AuthBunRequests]: (
					params: AuthBunRequests[K]["params"],
				) => Promise<AuthBunRequests[K]["response"]>;
			} = {
				requestAuth: async ({
					options: cfg,
				}: {
					options: RequestAuthOptions;
				}) => {
					await startAuthFlow({
						adapter,
						$fetch,
						clientOptions,
						options,
						cfg,
						onAuthenticated: (user) =>
							adapter.notifyRenderer({ type: "authenticated", user }),
						onError: (error) =>
							adapter.notifyRenderer({
								type: "error",
								error:
									error instanceof Error ? error : new Error(String(error)),
								path: "/desktop/init-oauth-proxy",
							}),
					});
					return undefined;
				},
				getUser: async () => {
					const result = await $fetch<{ user: AuthUser }>("/get-session", {
						method: "GET",
						headers: {
							cookie: getCookie(),
							"content-type": "application/json",
						},
					});
					return await sanitizeUser(result.data?.user ?? null);
				},
				signOut: async () => {
					await $fetch("/sign-out", {
						method: "POST",
						body: "{}",
						headers: {
							cookie: getCookie(),
							"content-type": "application/json",
						},
					});
					return undefined;
				},
				getUserImage: async ({ url }: { url: string }) => {
					const result = await fetchUserImage(clientOptions?.baseURL, url);
					if (!result) return { dataUrl: null };
					const { base64 } = await import("@better-auth/utils/base64");
					return {
						dataUrl: `data:${result.mimeType};base64,${base64.encode(result.bytes)}`,
					};
				},
			};

			return {
				getCookie,
				// Builds the bun-side RPC and registers it as the webview target.
				// Pass the result to `new BrowserWindow({ rpc })`.
				createBunRPC: (): ElectrobunDesktopRPC => {
					rpc = BrowserView.defineRPC<DesktopAuthRPC>({
						maxRequestTime: 30_000,
						handlers: { requests, messages: {} },
					}) as unknown as ElectrobunDesktopRPC;
					return rpc;
				},
				// Subscribes to session changes and pushes `onUserUpdated` to the
				// renderer. Returns an unsubscribe function.
				setupMain: async () => {
					const unsub = $store.atoms.session?.subscribe(async (state) => {
						if (state.isPending === true) return;
						const user = await sanitizeUser(state.data?.user ?? null);
						adapter.notifyRenderer({ type: "user-updated", user });
					});
					return () => unsub?.();
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
