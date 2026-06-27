import type { BetterAuthClientOptions } from "@better-auth/core";
import { BetterAuthError } from "@better-auth/core/error";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import type { BetterFetch, CreateFetchOption } from "@better-fetch/fetch";
import { getBaseURL, safeJSONParse } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import { buildLoopbackUrl, generateNonce, successPage } from "./loopback";
import type {
	AuthUser,
	DesktopAdapter,
	DesktopClientOptions,
	LoopbackResponse,
	LoopbackServer,
	RequestAuthOptions,
} from "./types";
import { normalizeUserOutput } from "./user";

// PKCE verifiers, keyed by OAuth `state`. The verifier never leaves this process.
const verifierStore = new Map<string, string>();

const DEFAULT_LOOPBACK_PATH = "/callback";
const DEFAULT_LOOPBACK_TIMEOUT = 300_000;

function randomVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64Url.encode(bytes);
}

function loopbackSuccessResponse(
	success: DesktopClientOptions["loopbackSuccess"],
): LoopbackResponse {
	if (success && typeof success === "object") {
		return { status: 302, headers: { location: success.redirectTo }, body: "" };
	}
	return {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body: success ?? successPage(),
	};
}

async function sanitize(
	user: AuthUser | null,
	options: DesktopClientOptions,
): Promise<AuthUser | null> {
	let u = user;
	if (u !== null && typeof options.sanitizeUser === "function") {
		try {
			u = await options.sanitizeUser(u);
		} catch (error) {
			console.error("Error while sanitizing user", error);
			u = null;
		}
	}
	if (u !== null) u = normalizeUserOutput(u, options);
	return u;
}

export type ExchangeTokenArgs = {
	$fetch: BetterFetch;
	options: DesktopClientOptions;
	token: string;
	onAuthenticated: (user: AuthUser) => void;
	fetchOptions?: Omit<CreateFetchOption, "method"> | undefined;
};

// One-time-code → session. Decodes the redirect token, looks up the matching
// PKCE verifier, and exchanges it at /desktop/token (which verifies the PKCE).
export async function exchangeToken({
	$fetch,
	options,
	token,
	onAuthenticated,
	fetchOptions,
}: ExchangeTokenArgs) {
	const decoded = safeJSONParse(
		new TextDecoder().decode(base64Url.decode(decodeURIComponent(token))),
	) as { identifier: string; state: string } | null;

	const codeVerifier = decoded ? verifierStore.get(decoded.state) : undefined;
	if (decoded) verifierStore.delete(decoded.state);

	if (!decoded || !codeVerifier) {
		throw new BetterAuthError("Code verifier not found.");
	}

	return await $fetch<{ token: string; user: AuthUser }>("/desktop/token", {
		...fetchOptions,
		method: "POST",
		body: {
			...(fetchOptions?.body || {}),
			token: decoded.identifier,
			state: decoded.state,
			code_verifier: codeVerifier,
		},
		onSuccess: async (ctx) => {
			const user = await sanitize(ctx.data?.user ?? null, options);
			if (user === null) return;
			await fetchOptions?.onSuccess?.(ctx);
			onAuthenticated(user);
		},
	});
}

export type StartAuthFlowArgs = {
	adapter: DesktopAdapter;
	$fetch: BetterFetch;
	clientOptions: BetterAuthClientOptions | undefined;
	options: DesktopClientOptions;
	cfg: RequestAuthOptions;
	onAuthenticated: (user: AuthUser) => void;
	onError?: (error: unknown) => void;
};

// Drives the full loopback hand-off: bind 127.0.0.1, open the system browser at
// init-oauth-proxy (carrying the loopback URL as callbackURL), and complete the
// exchange when the browser navigates back to the loopback.
export async function startAuthFlow({
	adapter,
	$fetch,
	clientOptions,
	options,
	cfg,
	onAuthenticated,
	onError,
}: StartAuthFlowArgs): Promise<void> {
	const baseURL = getBaseURL(
		clientOptions?.baseURL,
		clientOptions?.basePath,
		undefined,
		true,
	);
	if (!baseURL) {
		throw new BetterAuthError(
			"Base URL is required to start a desktop sign-in flow.",
		);
	}

	const state = generateRandomString(16, "A-Z", "a-z", "0-9");
	const codeVerifier = randomVerifier();
	const codeChallenge = base64Url.encode(
		await createHash("SHA-256").digest(codeVerifier),
	);
	verifierStore.set(state, codeVerifier);

	const nonce = generateNonce();
	const loopbackPath = options.loopbackPath ?? DEFAULT_LOOPBACK_PATH;

	let server: LoopbackServer | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const cleanup = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		server?.close();
		server = null;
		verifierStore.delete(state);
	};

	server = await adapter.serveLoopback(
		async (req) => {
			if (req.path !== loopbackPath) {
				return { status: 404, body: "Not found" };
			}
			if (req.query.nonce !== nonce) {
				return { status: 403, body: "Forbidden" };
			}
			const token = req.query.token;
			if (!token) return { status: 400, body: "Missing token" };
			try {
				await exchangeToken({
					$fetch,
					options,
					token,
					onAuthenticated,
					fetchOptions: { throw: true },
				});
			} catch (error) {
				cleanup();
				onError?.(error);
				return {
					status: 500,
					headers: { "content-type": "text/plain; charset=utf-8" },
					body: "Sign-in failed. You can close this tab.",
				};
			}
			cleanup();
			return loopbackSuccessResponse(options.loopbackSuccess);
		},
		{ port: options.loopbackPort },
	);

	const loopbackUrl = buildLoopbackUrl(server.port, loopbackPath, nonce);

	const url = new URL(`${baseURL}/desktop/init-oauth-proxy`);
	for (const [key, value] of Object.entries(cfg)) {
		if (value === undefined) continue;
		url.searchParams.set(
			key,
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}
	url.searchParams.set("client_id", options.clientID ?? "desktop");
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("callbackURL", loopbackUrl);

	timer = setTimeout(() => {
		cleanup();
		onError?.(new BetterAuthError("Desktop sign-in timed out."));
	}, options.loopbackTimeout ?? DEFAULT_LOOPBACK_TIMEOUT);

	try {
		await adapter.openExternal(url.toString());
	} catch (error) {
		cleanup();
		throw error;
	}
}
