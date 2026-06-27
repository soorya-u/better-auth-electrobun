import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type {
	BetterAuthClientOptions,
	BetterAuthClientPlugin,
	ClientStore,
} from "@better-auth/core";
import type { BetterFetch } from "@better-fetch/fetch";
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
import { PACKAGE_VERSION } from "../version";

// IPC channels shared between the main-process plugin and the renderer bridge.
export const ELECTRON_AUTH_CHANNELS = {
	requestAuth: "desktop:requestAuth",
	getUser: "desktop:getUser",
	signOut: "desktop:signOut",
	getUserImage: "desktop:getUserImage",
	onAuthenticated: "desktop:onAuthenticated",
	onUserUpdated: "desktop:onUserUpdated",
	onAuthError: "desktop:onAuthError",
} as const;

// Minimal structural views of the Electron APIs this adapter touches, so the
// package needs no `electron` / `@types/electron` dependency.
type ElectronShell = { openExternal(url: string): Promise<void> };
type WebContents = { send(channel: string, payload: unknown): void };
type ElectronWindowLike = { webContents: WebContents } | null | undefined;
type IpcMainLike = {
	handle(
		channel: string,
		listener: (event: unknown, ...args: any[]) => any,
	): void;
	removeHandler(channel: string): void;
};
type SafeStorage = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
};

async function loadElectron(): Promise<{
	shell: ElectronShell;
	ipcMain: IpcMainLike;
}> {
	const electron = (await import("electron")) as unknown as {
		shell: ElectronShell;
		ipcMain: IpcMainLike;
	};
	return { shell: electron.shell, ipcMain: electron.ipcMain };
}

export type ElectronStorageOptions = {
	/** electron-store file name (without extension). @default "better-auth-desktop" */
	name?: string;
	/** Encrypt values with Electron `safeStorage` (OS keychain) when available. @default true */
	encrypt?: boolean;
};

const ENC_PREFIX = "enc:";

// Default Electron storage: persistent via `electron-store`, values encrypted
// with `safeStorage` (Keychain / libsecret / DPAPI) when available. Both are
// loaded lazily so neither is a hard dependency of this package.
export async function electronStorage(
	opts: ElectronStorageOptions = {},
): Promise<Storage> {
	const { name = "better-auth-desktop", encrypt = true } = opts;

	const { default: Store } = (await import("electron-store")) as unknown as {
		default: new (o?: {
			name?: string;
		}) => {
			get(key: string): unknown;
			set(key: string, value: unknown): void;
		};
	};
	const store = new Store({ name });

	let safeStorage: SafeStorage | null = null;
	if (encrypt) {
		try {
			const electron = (await import("electron")) as unknown as {
				safeStorage?: SafeStorage;
			};
			if (electron.safeStorage?.isEncryptionAvailable()) {
				safeStorage = electron.safeStorage;
			}
		} catch {
			safeStorage = null;
		}
	}

	const seal = (value: string): string =>
		safeStorage
			? ENC_PREFIX + safeStorage.encryptString(value).toString("base64")
			: value;
	const open = (value: string): string => {
		if (!safeStorage || !value.startsWith(ENC_PREFIX)) return value;
		return safeStorage.decryptString(
			Buffer.from(value.slice(ENC_PREFIX.length), "base64"),
		);
	};

	return {
		getItem: (key) => {
			const raw = store.get(key);
			if (typeof raw !== "string") return null;
			try {
				return open(raw);
			} catch {
				return null;
			}
		},
		setItem: (key, value) => {
			store.set(key, seal(String(value)));
		},
	};
}

export type ElectronDesktopOptions = DesktopClientPluginOptions & {
	/** Returns the focused window whose renderer should receive auth events. */
	getWindow: () => ElectronWindowLike;
};

function createLoopbackAdapter(
	shell: ElectronShell,
	getWindow: () => ElectronWindowLike,
	storage: Storage,
): DesktopAdapter {
	return {
		openExternal: (url) => shell.openExternal(url),
		serveLoopback(onRequest, opts) {
			return new Promise((resolve) => {
				const server = createServer(async (req, res) => {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const query: Record<string, string> = {};
					url.searchParams.forEach((value, key) => {
						query[key] = value;
					});
					const out = await onRequest({ path: url.pathname, query });
					res.writeHead(out.status, out.headers);
					res.end(out.body);
				});
				server.listen(opts?.port ?? 0, "127.0.0.1", () => {
					const address = server.address();
					const port =
						typeof address === "object" && address ? address.port : 0;
					resolve({ port, close: () => server.close() });
				});
			});
		},
		notifyRenderer(event: AuthEvent) {
			const wc = getWindow()?.webContents;
			if (!wc) return;
			switch (event.type) {
				case "authenticated":
					wc.send(ELECTRON_AUTH_CHANNELS.onAuthenticated, event.user);
					break;
				case "user-updated":
					wc.send(ELECTRON_AUTH_CHANNELS.onUserUpdated, event.user);
					break;
				case "error":
					wc.send(ELECTRON_AUTH_CHANNELS.onAuthError, {
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
 * Better Auth client plugin for Electron (main process). Shares the same core
 * as the Electrobun plugin; pulls in **no** Electrobun code. Use it with
 * `createAuthClient`, then call `setupMain()` (which registers the IPC handlers
 * and the session subscription, and returns a cleanup function):
 *
 * ```ts
 * const authClient = createAuthClient({
 *   baseURL,
 *   plugins: [electronDesktop({ clientID, storage: await electronStorage(), getWindow })],
 * });
 * await authClient.setupMain();
 * ```
 */
export const electronDesktop = (options: ElectronDesktopOptions) => {
	const layer = createDesktopCookieLayer(options);

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

			return {
				getCookie,
				setupMain: async () => {
					const { shell, ipcMain } = await loadElectron();
					const adapter = createLoopbackAdapter(
						shell,
						options.getWindow,
						options.storage,
					);

					ipcMain.handle(
						ELECTRON_AUTH_CHANNELS.requestAuth,
						async (_event, cfg: RequestAuthOptions) => {
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
						},
					);
					ipcMain.handle(ELECTRON_AUTH_CHANNELS.getUser, async () => {
						const result = await $fetch<{ user: AuthUser }>("/get-session", {
							method: "GET",
							headers: {
								cookie: getCookie(),
								"content-type": "application/json",
							},
						});
						return await sanitizeUser(result.data?.user ?? null);
					});
					ipcMain.handle(ELECTRON_AUTH_CHANNELS.signOut, async () => {
						await $fetch("/sign-out", {
							method: "POST",
							body: "{}",
							headers: {
								cookie: getCookie(),
								"content-type": "application/json",
							},
						});
					});
					ipcMain.handle(
						ELECTRON_AUTH_CHANNELS.getUserImage,
						async (_event, url: string) => {
							const result = await fetchUserImage(clientOptions?.baseURL, url);
							if (!result) return { dataUrl: null };
							const { base64 } = await import("@better-auth/utils/base64");
							return {
								dataUrl: `data:${result.mimeType};base64,${base64.encode(result.bytes)}`,
							};
						},
					);

					const unsub = $store.atoms.session?.subscribe(async (state) => {
						if (state.isPending === true) return;
						const user = await sanitizeUser(state.data?.user ?? null);
						adapter.notifyRenderer({ type: "user-updated", user });
					});

					return () => {
						unsub?.();
						ipcMain.removeHandler(ELECTRON_AUTH_CHANNELS.requestAuth);
						ipcMain.removeHandler(ELECTRON_AUTH_CHANNELS.getUser);
						ipcMain.removeHandler(ELECTRON_AUTH_CHANNELS.signOut);
						ipcMain.removeHandler(ELECTRON_AUTH_CHANNELS.getUserImage);
					};
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
