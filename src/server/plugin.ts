import type {
	AuthContext,
	GenericEndpointContext,
	HookEndpointContext,
} from "@better-auth/core";
import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import type { BetterAuthPlugin } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import { PACKAGE_VERSION } from "../version";
import { DESKTOP_ERROR_CODES } from "./error-codes";
import {
	desktopInitOAuthProxy,
	desktopOAuthComplete,
	desktopToken,
} from "./routes";
import type { DesktopServerOptions, ResolvedServerOptions } from "./types";

// Paths where Better Auth may establish a session; the cookie-preservation hook
// runs on everything *else* (e.g. the oAuthProxy bounce through
// /oauth-proxy-callback) to keep the transfer cookie alive across the round-trip.
const isAuthPath = (ctx: HookEndpointContext) =>
	!!(
		ctx.path?.startsWith("/sign-in") ||
		ctx.path?.startsWith("/sign-up") ||
		ctx.path?.startsWith("/callback") ||
		ctx.path?.startsWith("/oauth2/callback") ||
		ctx.path?.startsWith("/magic-link/verify") ||
		ctx.path?.startsWith("/email-otp/verify-email") ||
		ctx.path?.startsWith("/verify-email") ||
		ctx.path?.startsWith("/one-tap/callback") ||
		ctx.path?.startsWith("/passkey/verify-authentication") ||
		ctx.path?.startsWith("/phone-number/verify")
	);

export const betterAuthDesktop = (
	options?: DesktopServerOptions,
): BetterAuthPlugin => {
	const opts: ResolvedServerOptions = {
		clientID: options?.clientID ?? "desktop",
		codeExpiresIn: options?.codeExpiresIn ?? 300,
		hashKey: options?.hashKey ?? "token",
		webCallbackUrl: options?.webCallbackUrl,
		allowedLoopbackPorts: options?.allowedLoopbackPorts,
	};
	const disableOriginOverride = options?.disableOriginOverride;

	const handleTransfer = async (
		ctx: GenericEndpointContext,
		payload: {
			client_id: string;
			state: string;
			code_challenge: string;
			code_challenge_method?: string | undefined;
		},
	): Promise<string | null> => {
		const { client_id, state, code_challenge, code_challenge_method } = payload;
		const userId =
			ctx.context.session?.user.id || ctx.context.newSession?.user.id;
		if (!userId || client_id !== opts.clientID) return null;

		if (!state)
			throw APIError.from("BAD_REQUEST", DESKTOP_ERROR_CODES.MISSING_STATE);
		if (!code_challenge)
			throw APIError.from("BAD_REQUEST", DESKTOP_ERROR_CODES.MISSING_PKCE);
		if (code_challenge_method?.toLowerCase() !== "s256") {
			throw APIError.from(
				"BAD_REQUEST",
				DESKTOP_ERROR_CODES.INVALID_PKCE_METHOD,
			);
		}

		const identifier = generateRandomString(32, "a-z", "A-Z", "0-9");
		const expiresAt = new Date(Date.now() + opts.codeExpiresIn * 1000);
		await ctx.context.internalAdapter.createVerificationValue({
			identifier: `desktop:${identifier}`,
			value: JSON.stringify({
				userId,
				codeChallenge: code_challenge,
				codeChallengeMethod: "s256",
				state,
			}),
			expiresAt,
		});

		return identifier;
	};

	return {
		id: "desktop",
		version: PACKAGE_VERSION,
		async onRequest(request: Request, _ctx: AuthContext) {
			if (disableOriginOverride || request.headers.get("origin")) return;
			const desktopOrigin = request.headers.get("desktop-origin");
			if (!desktopOrigin) return;
			// A cloned incoming request has immutable headers on Cloudflare Workers,
			// so build a fresh Headers + Request to rewrite the origin.
			const headers = new Headers(request.headers);
			headers.set("origin", desktopOrigin);
			return {
				request: new Request(request, { headers }) as unknown as typeof request,
			};
		},
		hooks: {
			after: [
				{
					matcher: (ctx: HookEndpointContext) => !isAuthPath(ctx),
					handler: createAuthMiddleware(async (ctx) => {
						const cookie = ctx.context.createAuthCookie("transfer_token", {
							maxAge: opts.codeExpiresIn,
						});
						const transferCookie = await ctx.getSignedCookie(
							cookie.name,
							ctx.context.secret,
						);
						if (!ctx.context.newSession?.session || !transferCookie) return;
						await ctx.setSignedCookie(
							cookie.name,
							transferCookie,
							ctx.context.secret,
							cookie.attributes,
						);
					}),
				},
			],
		},
		endpoints: {
			desktopToken: desktopToken(opts),
			desktopInitOAuthProxy: desktopInitOAuthProxy(opts),
			desktopOAuthComplete: desktopOAuthComplete(opts, { handleTransfer }),
		},
		options: opts,
		$ERROR_CODES: DESKTOP_ERROR_CODES,
		// Cast (not `satisfies`) to stay compatible with Cloudflare's augmented Request.
	} as unknown as BetterAuthPlugin;
};
