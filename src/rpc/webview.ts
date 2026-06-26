/**
 * Renderer-side auth bridge. Replaces `@better-auth/electron/preload`'s
 * `contextBridge.exposeInMainWorld` with a typed Electrobun RPC.
 *
 * Call once at the top of your webview entry (e.g. in `tabview-main.tsx`),
 * then use the returned {@link AuthBridges} (or stash it on `window.auth`):
 *
 * ```ts
 * import { defineAuthWebviewRPC } from "@soorya-u/better-auth-electrobun/rpc/webview";
 * export const auth = defineAuthWebviewRPC();
 *
 * auth.onAuthenticated((user) => setUser(user));
 * await auth.requestAuth({ provider: "google" });
 * ```
 *
 * Type safety: both sides reference {@link ElectrobunAuthRPC}, so any
 * rename/shape change is a compile error on both ends.
 */
import { Electroview } from "electrobun/view";
import type { RequestAuthOptions } from "../types/auth";
import type { AuthBridges, ElectrobunAuthRPC } from "./schema";

export function defineAuthWebviewRPC(): AuthBridges {
	const rpc = Electroview.defineRPC<ElectrobunAuthRPC>({
		maxRequestTime: 30_000,
		handlers: {
			requests: {},
			messages: {},
		},
	});

	// Wires the socket/postMessage transport. Must run before any
	// `rpc.request.*` / `rpc.send.*` call.
	new Electroview({ rpc });

	return {
		getUser: () => rpc.request.getUser({}),
		requestAuth: (options?: RequestAuthOptions) =>
			rpc.request.requestAuth({ options }),
		signOut: () => rpc.request.signOut({}),
		authenticate: (data: { token: string }) => rpc.request.authenticate(data),
		getUserImage: (url: string) => rpc.request.getUserImage({ url }),
		onAuthenticated: (callback) => {
			const handler = (user: Parameters<typeof callback>[0]) => callback(user);
			rpc.addMessageListener("onAuthenticated", handler);
			return () => rpc.removeMessageListener("onAuthenticated", handler);
		},
		onUserUpdated: (callback) => {
			const handler = (user: Parameters<typeof callback>[0]) => callback(user);
			rpc.addMessageListener("onUserUpdated", handler);
			return () => rpc.removeMessageListener("onUserUpdated", handler);
		},
		onAuthError: (callback) => {
			const handler = (ctx: Parameters<typeof callback>[0]) => callback(ctx);
			rpc.addMessageListener("onAuthError", handler);
			return () => rpc.removeMessageListener("onAuthError", handler);
		},
	};
}
