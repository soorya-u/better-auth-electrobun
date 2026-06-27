/**
 * Renderer-side auth bridge for the Electrobun WebView. Call once at the top of
 * your webview entry, then use the returned bridge:
 *
 * ```ts
 * import { defineAuthWebviewRPC } from "@soorya-u/better-auth-desktop/rpc/webview";
 * export const auth = defineAuthWebviewRPC();
 *
 * auth.onAuthenticated((user) => navigate("/threads"));
 * await auth.requestAuth({ provider: "github" });
 * ```
 */
import { Electroview } from "electrobun/view";
import type { RequestAuthOptions } from "../core/types";
import type { AuthBridges, DesktopAuthRPC } from "./schema";

export function defineAuthWebviewRPC(): AuthBridges {
	const rpc = Electroview.defineRPC<DesktopAuthRPC>({
		maxRequestTime: 30_000,
		handlers: { requests: {}, messages: {} },
	});

	// Wires the transport. Must run before any rpc.request.* / rpc.send.* call.
	new Electroview({ rpc });

	return {
		getUser: () => rpc.request.getUser({}),
		requestAuth: (options: RequestAuthOptions) =>
			rpc.request.requestAuth({ options }),
		signOut: () => rpc.request.signOut({}),
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
