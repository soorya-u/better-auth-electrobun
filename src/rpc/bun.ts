import type { BetterAuthClientOptions, ClientStore } from "@better-auth/core";
import type { User } from "@better-auth/core/db";
import type { BetterFetch, BetterFetchError } from "@better-fetch/fetch";
import { BrowserView } from "electrobun/bun";
import { authenticate, requestAuth } from "../authenticate";
import type { RequestAuthOptions } from "../types/auth";
import type { ElectrobunClientOptions } from "../types/client";
import { fetchUserImage, normalizeUserOutput } from "../user";
import type { ElectrobunAuthRPC } from "./schema";

export type ElectrobunAuthBunRpc = {
	send: AuthSender;
	setTransport(transport: unknown): void;
};

export type AuthBunRPCContext = {
	$fetch: BetterFetch;
	$store: ClientStore | null;
	getCookie: () => string;
	clientOptions: BetterAuthClientOptions | undefined;
	options: ElectrobunClientOptions;
	getWebview: () => {
		rpc: { send: AuthSender } | null;
	} | null;
};

export type AuthSender = {
	onAuthenticated: (payload: User & Record<string, any>) => void;
	onUserUpdated: (payload: (User & Record<string, any>) | null) => void;
	onAuthError: (payload: { error: BetterFetchError; path: string }) => void;
};

export function authRequestHandlers(ctx: AuthBunRPCContext) {
	const sanitize = async (
		user: (User & Record<string, any>) | null,
	): Promise<(User & Record<string, any>) | null> => {
		let u: (User & Record<string, any>) | null = user;
		if (u !== null && typeof ctx.options.sanitizeUser === "function") {
			try {
				u = await ctx.options.sanitizeUser(u);
			} catch (error) {
				console.error("Error while sanitizing user", error);
				u = null;
			}
		}
		if (u !== null) {
			u = normalizeUserOutput(u, ctx.options);
		}
		return u ?? null;
	};

	const notifyAuthenticated = (user: User & Record<string, any>) => {
		ctx.getWebview()?.rpc?.send.onAuthenticated(user);
	};

	return {
		getUser: async () => {
			const result = await ctx.$fetch<{
				user: User & Record<string, any>;
			}>("/get-session", {
				method: "GET",
				headers: {
					cookie: ctx.getCookie(),
					"content-type": "application/json",
				},
			});
			const user = await sanitize(result.data?.user ?? null);
			return user ?? null;
		},
		requestAuth: async ({ options: cfg }: { options?: RequestAuthOptions }) => {
			await requestAuth(ctx.clientOptions, ctx.options, cfg);
			return undefined;
		},
		signOut: async () => {
			await ctx.$fetch("/sign-out", {
				method: "POST",
				body: "{}",
				headers: {
					cookie: ctx.getCookie(),
					"content-type": "application/json",
				},
			});
			return undefined;
		},
		authenticate: async ({ token }: { token: string }) => {
			await authenticate({
				$fetch: ctx.$fetch,
				options: ctx.options,
				token,
				notifyAuthenticated,
				fetchOptions: { throw: true },
			});
			return undefined;
		},
		getUserImage: async ({ url }: { url: string }) => {
			const baseURL = ctx.clientOptions?.baseURL;
			const result = await fetchUserImage(baseURL, url);
			if (!result) return { dataUrl: null };
			const { base64 } = await import("@better-auth/utils/base64");
			return {
				dataUrl: `data:${result.mimeType};base64,${base64.encode(result.bytes)}`,
			};
		},
	};
}

export function createAuthBunRPC(ctx: AuthBunRPCContext): ElectrobunAuthBunRpc {
	return BrowserView.defineRPC<ElectrobunAuthRPC>({
		maxRequestTime: 30_000,
		handlers: {
			requests: authRequestHandlers(ctx),
			messages: {},
		},
	}) as unknown as ElectrobunAuthBunRpc;
}
