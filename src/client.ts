import type {
	BetterAuthClientOptions,
	BetterAuthClientPlugin,
	ClientStore,
} from "@better-auth/core";
import type { BetterFetch } from "@better-fetch/fetch";
import { isDevelopment, isTest } from "better-auth";
import type { ElectrobunAuthenticateOptions } from "./authenticate";
import { authenticate, requestAuth } from "./authenticate";
import {
	getCookie,
	getSetCookie,
	hasBetterAuthCookies,
	hasSessionCookieChanged,
} from "./cookies";
import type { AuthBunRPCContext, AuthSender } from "./rpc/bun";
import type { ExposedBridges } from "./rpc/schema";
import {
	clearSessionCookies,
	mirrorCookiesToSession,
	setupMain,
} from "./setup";
import type { ElectrobunClientOptions, Storage } from "./types/client";
import { parseProtocolScheme } from "./utils";
import { PACKAGE_VERSION } from "./version";

const storageAdapter = (storage: Storage, sessionKeys: Set<string>) => {
	const memory = new Map<string, string>();

	const getEncrypted = (name: string): string | null => {
		if (sessionKeys.has(name) && memory.has(name)) {
			return memory.get(name) ?? null;
		}
		const item = storage.getItem(name);
		if (!item || typeof item !== "string") return null;
		return item;
	};

	const setEncrypted = (name: string, value: string) => {
		if (sessionKeys.has(name)) {
			memory.set(name, value);
			return;
		}
		try {
			storage.setItem(name, value);
		} catch {
			//
		}
	};

	return { getEncrypted, setEncrypted };
};

const ELECTROBUN_UA = `Electrobun better-auth-electrobun/${PACKAGE_VERSION}`;

export const electrobunClient = <O extends ElectrobunClientOptions>(
	options: O,
) => {
	const opts: ElectrobunClientOptions = {
		storagePrefix: "better-auth",
		cookiePrefix: "better-auth",
		channelPrefix: "better-auth",
		callbackPath: "/auth/callback",
		...options,
	};

	const { scheme } = parseProtocolScheme(opts.protocol);

	let store: ClientStore | null = null;
	let clientOptionsRef: BetterAuthClientOptions | undefined;

	const cookieName = `${opts.storagePrefix}.cookie`;
	const localCacheName = `${opts.storagePrefix}.local_cache`;
	const { getEncrypted, setEncrypted } = storageAdapter(
		opts.storage,
		new Set([cookieName, localCacheName]),
	);

	const clearSessionCache = () => {
		setEncrypted(cookieName, "");
		void clearSessionCookies(opts.sessionPartition);
		store?.atoms.session?.set({
			...store.atoms.session.get(),
			data: null,
			error: null,
			isPending: false,
		});
		setEncrypted(localCacheName, "");
	};

	if (
		(isDevelopment() || isTest()) &&
		/^(?!\.)(?!.*\.\.)(?!.*\.$)[^.]+\.[^.]+$/.test(scheme)
	) {
		console.warn(
			"The provided scheme does not follow the reverse domain name notation. For example: `app.example.com` -> `com.example.app`.",
		);
	}

	const getCookieFn = () => {
		const cookie = getEncrypted(cookieName);
		return getCookie(cookie || "");
	};

	let getWebview: AuthBunRPCContext["getWebview"] = () => null;

	const sender = (): AuthSender | null => getWebview()?.rpc?.send ?? null;

	return {
		id: "electrobun",
		version: PACKAGE_VERSION,
		fetchPlugins: [
			{
				id: "electrobun",
				name: "Electrobun",
				async init(url, options) {
					const storedCookie = getEncrypted(cookieName);
					const cookie = getCookie(storedCookie || "");
					const resolvedOptions = options ?? {};
					resolvedOptions.credentials = "omit";
					resolvedOptions.headers = {
						...resolvedOptions.headers,
						cookie,
						"user-agent": ELECTROBUN_UA,
						"electron-origin": `${scheme}:/`,
						"x-skip-oauth-proxy": "true",
					};

					if (url.endsWith("/sign-out")) {
						clearSessionCache();
					}

					return {
						url,
						options: resolvedOptions,
					};
				},
				hooks: {
					onSuccess: async (context) => {
						const setCookie = context.response.headers.get("set-cookie");

						if (setCookie) {
							if (hasBetterAuthCookies(setCookie, opts.cookiePrefix as never)) {
								const prevCookie = getEncrypted(cookieName);
								const toSetCookie = getSetCookie(
									setCookie || "",
									prevCookie ?? undefined,
								);

								if (hasSessionCookieChanged(prevCookie, toSetCookie)) {
									setEncrypted(cookieName, toSetCookie);
									void mirrorCookiesToSession(
										toSetCookie,
										clientOptionsRef?.baseURL,
										opts.sessionPartition,
									);
									store?.notify("$sessionSignal");
								} else {
									setEncrypted(cookieName, toSetCookie);
									void mirrorCookiesToSession(
										toSetCookie,
										clientOptionsRef?.baseURL,
										opts.sessionPartition,
									);
								}
							}
						}

						if (
							context.request.url.toString().includes("/get-session") &&
							!opts.disableCache
						) {
							const data = context.data;
							setEncrypted(localCacheName, JSON.stringify(data));
						}
						if (context.request.url.toString().includes("/sign-out")) {
							clearSessionCache();
						}
					},
					onError: async (context) => {
						sender()?.onAuthError({
							error: context.error,
							path: String(context.request.url),
						});
					},
				},
			},
		],
		getActions: (
			$fetch: BetterFetch,
			$store: ClientStore,
			clientOptions: BetterAuthClientOptions | undefined,
		) => {
			store = $store;
			clientOptionsRef = clientOptions;

			return {
				getCookie: getCookieFn,
				authenticate: async (data: ElectrobunAuthenticateOptions) => {
					return await authenticate({
						...data,
						$fetch,
						options: opts,
						notifyAuthenticated: (user) => sender()?.onAuthenticated(user),
					});
				},
				requestAuth: (cfg?: Parameters<typeof requestAuth>[2] | undefined) =>
					requestAuth(clientOptions, opts, cfg),
				setupMain: async (cfg?: {
					getWebview?: AuthBunRPCContext["getWebview"];
				}) => {
					if (cfg?.getWebview) getWebview = cfg.getWebview;
					return setupMain({
						$fetch,
						$store,
						getCookie: getCookieFn,
						options: opts,
						clientOptions,
						sender,
					});
				},
				$Infer: {} as {
					Bridges: ExposedBridges;
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};

export type { AuthBunRPCContext, AuthSender } from "./rpc/bun";
export { handleDeepLink } from "./setup";
export type * from "./types/client";
export { normalizeUserOutput } from "./user";
