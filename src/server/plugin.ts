import type {
	AuthContext,
	GenericEndpointContext,
	HookEndpointContext,
} from "@better-auth/core";
import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { base64Url } from "@better-auth/utils/base64";
import type { BetterAuthPlugin } from "better-auth";
import { safeJSONParse } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import * as z from "zod";
import type { ElectrobunServerOptions } from "../types/options";
import { PACKAGE_VERSION } from "../version";
import { ELECTROBUN_ERROR_CODES } from "./error-codes";
import {
	electrobunInitOAuthProxy,
	electrobunOAuthComplete,
	electrobunToken,
	electrobunTransferUser,
} from "./routes";

const hookMatcher = (ctx: HookEndpointContext) =>
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

export const electrobun = (options?: ElectrobunServerOptions): BetterAuthPlugin => {
	const opts = {
		codeExpiresIn: options?.codeExpiresIn ?? 300,
		clientID: options?.clientID ?? "electrobun",
		disableOriginOverride: options?.disableOriginOverride,
		cookiePrefix:
			(options?.origin === "same" ? options.cookies.cookiePrefix : undefined) ??
			"better-auth",
		redirectCookieExpiresIn:
			(options?.origin === "same"
				? options.cookies.redirectCookieExpiresIn
				: undefined) ?? 120,
		callback: options?.origin === "cross" ? options.callback : undefined,
	};

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
			throw APIError.from("BAD_REQUEST", ELECTROBUN_ERROR_CODES.MISSING_STATE);
		if (!code_challenge)
			throw APIError.from("BAD_REQUEST", ELECTROBUN_ERROR_CODES.MISSING_PKCE);
		if (code_challenge_method?.toLowerCase() !== "s256") {
			throw APIError.from(
				"BAD_REQUEST",
				ELECTROBUN_ERROR_CODES.INVALID_PKCE_METHOD,
			);
		}

		const identifier = generateRandomString(32, "a-z", "A-Z", "0-9");
		const expiresAt = new Date(Date.now() + opts.codeExpiresIn * 1000);
		await ctx.context.internalAdapter.createVerificationValue({
			identifier: `electrobun:${identifier}`,
			value: JSON.stringify({
				userId,
				codeChallenge: code_challenge,
				codeChallengeMethod: "s256",
				state,
			}),
			expiresAt,
		});

		const redirectToken = base64Url.encode(
			new TextEncoder().encode(JSON.stringify({ identifier, state })),
		);

		// Always set the cookie so electronTransferUser (same-domain flow) still works.
		const redirectCookieName = `${opts.cookiePrefix}.${opts.clientID}`;
		ctx.setCookie(redirectCookieName, redirectToken, {
			...ctx.context.authCookies.sessionToken.attributes,
			maxAge: opts.redirectCookieExpiresIn,
			httpOnly: false,
		});

		return identifier;
	};

	return {
		id: "electrobun",
		version: PACKAGE_VERSION,
		async onRequest(request: Request, _ctx: AuthContext) {
			if (opts.disableOriginOverride || request.headers.get("origin")) return;
			const electrobunOrigin = request.headers.get("electrobun-origin");
			if (!electrobunOrigin) return;
			const req = request.clone();
			req.headers.set("origin", electrobunOrigin);
			return { request: req as unknown as typeof request };
		},
		hooks: {
			after: [
				{
					matcher: (ctx: HookEndpointContext) => !hookMatcher(ctx),
					handler: createAuthMiddleware(async (ctx) => {
						const transferCookie = await ctx.getSignedCookie(
							`${opts.cookiePrefix}.transfer_token`,
							ctx.context.secret,
						);
						if (!ctx.context.newSession?.session || !transferCookie) return;
						const cookie = ctx.context.createAuthCookie("transfer_token", {
							maxAge: opts.codeExpiresIn,
						});
						await ctx.setSignedCookie(
							cookie.name,
							transferCookie,
							ctx.context.secret,
							cookie.attributes,
						);
					}),
				},
				{
					matcher: hookMatcher,
					handler: createAuthMiddleware(async (ctx) => {
						const querySchema = z.object({
							client_id: z.string(),
							code_challenge: z.string().nonempty(),
							code_challenge_method: z.string().optional(),
							state: z.string().nonempty(),
						});
						const cookie = ctx.context.createAuthCookie("transfer_token", {
							maxAge: opts.codeExpiresIn,
						});

						if (
							ctx.query?.client_id === opts.clientID &&
							(ctx.path.startsWith("/sign-in") ||
								ctx.path.startsWith("/sign-up"))
						) {
							const query = querySchema.safeParse(ctx.query);
							if (query.success) {
								await ctx.setSignedCookie(
									cookie.name,
									JSON.stringify(query.data),
									ctx.context.secret,
									cookie.attributes,
								);
							}
						}

						// Cross-domain completion is handled by /electrobun/oauth-complete
						// (the OAuth callbackURL); the hook only plants the cookie above.
						if (opts.callback) return;

						if (!ctx.context.newSession?.session) return;

						const transferCookie = await ctx.getSignedCookie(
							cookie.name,
							ctx.context.secret,
						);
						ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });

						let transferPayload: z.infer<typeof querySchema> | null = null;
						if (transferCookie) {
							transferPayload = safeJSONParse(transferCookie);
						} else {
							const query = querySchema.safeParse(ctx.query);
							if (query.success && query.data.client_id === opts.clientID) {
								transferPayload = query.data;
							}
						}
						if (!transferPayload) return;

						const identifier = await handleTransfer(ctx, transferPayload);
						if (identifier === null) return ctx;

						return ctx.json({
							...(ctx.context.returned ?? {}),
							electrobun_authorization_code: identifier,
						});
					}),
				},
			],
		},
		endpoints: {
			electrobunToken: electrobunToken(opts),
			electrobunInitOAuthProxy: electrobunInitOAuthProxy(opts),
			electrobunOAuthComplete: electrobunOAuthComplete(opts, { handleTransfer }),
			electrobunTransferUser: electrobunTransferUser(opts, { handleTransfer }),
		},
		options: opts,
		$ERROR_CODES: ELECTROBUN_ERROR_CODES,
		// Cast (not `satisfies`) to stay compatible with Cloudflare's augmented Request.
	} as unknown as BetterAuthPlugin;
};
