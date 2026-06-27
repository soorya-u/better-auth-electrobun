import type { BetterAuthClientOptions } from "@better-auth/core";
import type { User } from "@better-auth/core/db";
import { BetterAuthError } from "@better-auth/core/error";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import type { BetterFetch, CreateFetchOption } from "@better-fetch/fetch";
import { APIError, getBaseURL, safeJSONParse } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import type { RequestAuthOptions } from "./types/auth";
import type { ElectrobunClientOptions } from "./types/client";
import { normalizeUserOutput } from "./user";

export const kElectrobun = Symbol.for("better-auth:electrobun");

export type { RequestAuthOptions as ElectronRequestAuthOptions } from "./types/auth";

export type ElectrobunAuthenticateOptions = {
	fetchOptions?: Omit<CreateFetchOption, "method"> | undefined;
	token: string;
};

export async function requestAuth(
	clientOptions: BetterAuthClientOptions | undefined,
	options: ElectrobunClientOptions,
	cfg?: RequestAuthOptions | undefined,
) {
	const { Utils } = await import("electrobun/bun");
	const { randomBytes } = await import("node:crypto");

	const state = generateRandomString(16, "A-Z", "a-z", "0-9");
	const codeVerifier = base64Url.encode(randomBytes(32));
	const codeChallenge = base64Url.encode(
		await createHash("SHA-256").digest(codeVerifier),
	);

	const store: Map<string, string> =
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-init pattern from @better-auth/electron
		((globalThis as any)[kElectrobun] ??= new Map<string, string>());
	store.set(state, codeVerifier);

	let url: URL | null = null;
	if (cfg?.provider) {
		const baseURL = getBaseURL(
			clientOptions?.baseURL,
			clientOptions?.basePath,
			undefined,
			true,
		);
		if (!baseURL) {
			console.log("No base URL found in client options");
			throw APIError.from("INTERNAL_SERVER_ERROR", {
				code: "NO_BASE_URL",
				message: "Base URL is required to use provider-based sign-in.",
			});
		}
		url = new URL(`${baseURL}/electrobun/init-oauth-proxy`);
		for (const [key, value] of Object.entries(cfg)) {
			if (value === undefined) continue;
			url.searchParams.set(
				key,
				typeof value === "string" ? value : JSON.stringify(value),
			);
		}
	} else {
		url = new URL(options.signInURL);
	}
	url.searchParams.set("client_id", options.clientID || "electrobun");
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);

	const ok = Utils.openExternal(url.toString());
	if (!ok) {
		throw new BetterAuthError(
			`Failed to open the system browser for authentication: ${url.toString()}`,
		);
	}
}

export async function authenticate({
	$fetch,
	options,
	token,
	notifyAuthenticated,
	fetchOptions,
}: ElectrobunAuthenticateOptions & {
	$fetch: BetterFetch;
	options: ElectrobunClientOptions;
	notifyAuthenticated: (user: User & Record<string, any>) => void;
}) {
	const decoded = safeJSONParse(
		new TextDecoder().decode(base64Url.decode(decodeURIComponent(token))),
	) as { identifier: string; state: string };

	const codeVerifier = (globalThis as any)[kElectrobun]?.get(decoded?.state);
	(globalThis as any)[kElectrobun]?.delete(decoded?.state);

	if (!codeVerifier) {
		throw new BetterAuthError("Code verifier not found.");
	}

	return await $fetch<{
		token: string;
		user: User & Record<string, any>;
	}>("/electrobun/token", {
		...fetchOptions,
		method: "POST",
		body: {
			...(fetchOptions?.body || {}),
			token: decoded.identifier,
			state: decoded.state,
			code_verifier: codeVerifier,
		},
		onSuccess: async (ctx) => {
			let user: (User & Record<string, any>) | null = ctx.data?.user ?? null;
			if (user !== null && typeof options.sanitizeUser === "function") {
				try {
					user = await options.sanitizeUser(user);
				} catch (error) {
					console.error("Error while sanitizing user", error);
					user = null;
				}
			}
			if (user === null) return;
			user = normalizeUserOutput(user, options);
			await fetchOptions?.onSuccess?.(ctx);
			notifyAuthenticated(user);
		},
	});
}
