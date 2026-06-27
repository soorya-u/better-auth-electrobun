import type {
	BetterAuthClientOptions,
	BetterAuthClientPlugin,
	ClientStore,
} from "@better-auth/core";
import type { BetterFetch, BetterFetchPlugin } from "@better-fetch/fetch";
import { PACKAGE_VERSION } from "../version";
import { getCookie, getSetCookie, hasBetterAuthCookies } from "./cookies";
import type { DesktopClientOptions, Storage } from "./types";

export type DesktopClientPluginOptions = DesktopClientOptions & {
	storage: Storage;
};

export type DesktopClientInternals = {
	$fetch: BetterFetch;
	$store: ClientStore;
	clientOptions: BetterAuthClientOptions | undefined;
	getCookie: () => string;
	clearSession: () => void;
};

const USER_AGENT = `better-auth-desktop/${PACKAGE_VERSION}`;

export type DesktopCookieLayer = {
	fetchPlugin: BetterFetchPlugin;
	getCookie: () => string;
	clearSession: () => void;
	bindStore: (store: ClientStore) => void;
	bindServerOrigin: (baseURL: string | undefined) => void;
};

// Shared cookie machinery for any desktop adapter: persists cookies to keychain
// storage, replays them on every request, and rewrites the request origin to the
// server's own origin (via `desktop-origin`) so CSRF/origin checks pass.
export function createDesktopCookieLayer(
	options: DesktopClientPluginOptions,
): DesktopCookieLayer {
	const opts = {
		storagePrefix: "better-auth",
		cookiePrefix: "better-auth",
		...options,
	} satisfies DesktopClientPluginOptions;

	const cookieName = `${opts.storagePrefix}.cookie`;
	const localCacheName = `${opts.storagePrefix}.local_cache`;

	const getStored = (name: string): string | null => {
		const item = opts.storage.getItem(name);
		return typeof item === "string" ? item : null;
	};
	const setStored = (name: string, value: string) => {
		try {
			opts.storage.setItem(name, value);
		} catch {
			//
		}
	};

	let store: ClientStore | null = null;
	let serverOrigin: string | undefined;

	const originOf = (url: string): string => {
		if (serverOrigin) return serverOrigin;
		try {
			return new URL(url).origin;
		} catch {
			return "";
		}
	};

	const getCookieFn = () => getCookie(getStored(cookieName) || "");

	const clearSession = () => {
		setStored(cookieName, "");
		setStored(localCacheName, "");
		store?.atoms.session?.set({
			...store.atoms.session.get(),
			data: null,
			error: null,
			isPending: false,
		});
	};

	const fetchPlugin: BetterFetchPlugin = {
		id: "desktop",
		name: "Desktop",
		async init(url, fetchOptions) {
			const resolvedOptions = fetchOptions ?? {};
			resolvedOptions.credentials = "omit";
			resolvedOptions.headers = {
				...resolvedOptions.headers,
				cookie: getCookieFn(),
				"user-agent": USER_AGENT,
				"desktop-origin": originOf(url),
				"x-skip-oauth-proxy": "true",
			};
			if (url.endsWith("/sign-out")) clearSession();
			return { url, options: resolvedOptions };
		},
		hooks: {
			onSuccess: async (context) => {
				const setCookie = context.response.headers.get("set-cookie");
				if (
					setCookie &&
					hasBetterAuthCookies(setCookie, opts.cookiePrefix as never)
				) {
					const prevCookie = getStored(cookieName);
					setStored(
						cookieName,
						getSetCookie(setCookie, prevCookie ?? undefined),
					);
					store?.notify("$sessionSignal");
				}
				const requestUrl = context.request.url.toString();
				if (requestUrl.includes("/get-session") && !opts.disableCache) {
					setStored(localCacheName, JSON.stringify(context.data));
				}
				if (requestUrl.includes("/sign-out")) clearSession();
			},
		},
	};

	return {
		fetchPlugin,
		getCookie: getCookieFn,
		clearSession,
		bindStore: (s) => {
			store = s;
		},
		bindServerOrigin: (baseURL) => {
			if (!baseURL) return;
			try {
				serverOrigin = new URL(baseURL).origin;
			} catch {
				//
			}
		},
	};
}

// Framework-agnostic Better Auth client plugin. Exposes the captured fetch/store
// internals so a runtime adapter can drive the loopback flow.
export const desktopClient = (options: DesktopClientPluginOptions) => {
	const layer = createDesktopCookieLayer(options);

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
			return {
				getCookie: layer.getCookie,
				getDesktopInternals: (): DesktopClientInternals => ({
					$fetch,
					$store,
					clientOptions,
					getCookie: layer.getCookie,
					clearSession: layer.clearSession,
				}),
			};
		},
	} satisfies BetterAuthClientPlugin;
};
