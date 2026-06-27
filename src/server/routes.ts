import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { GenericEndpointContext } from "@better-auth/core";
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
import { SocialProviderListEnum } from "@better-auth/core/social-providers";
import { safeJSONParse } from "@better-auth/core/utils/json";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import { betterFetch } from "@better-fetch/fetch";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { User } from "better-auth/db";
import { parseUserOutput } from "better-auth/db";
import * as z from "zod";
import { ELECTROBUN_ERROR_CODES } from "./error-codes";

export const electrobunToken = (_opts: unknown) =>
	createAuthEndpoint(
		"/electrobun/token",
		{
			method: "POST",
			body: z.object({
				token: z.string().nonempty(),
				state: z.string().nonempty(),
				code_verifier: z.string().nonempty(),
			}),
			metadata: { scope: "http" },
		},
		async (ctx) => {
			const token = await ctx.context.internalAdapter.consumeVerificationValue(
				`electrobun:${ctx.body.token}`,
			);
			if (!token) {
				throw APIError.from("NOT_FOUND", ELECTROBUN_ERROR_CODES.INVALID_TOKEN);
			}

			const tokenRecord = safeJSONParse<Record<string, any>>(token.value);
			if (!tokenRecord) {
				throw APIError.from(
					"INTERNAL_SERVER_ERROR",
					ELECTROBUN_ERROR_CODES.INVALID_TOKEN,
				);
			}

			if (tokenRecord.state !== ctx.body.state) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.STATE_MISMATCH,
				);
			}
			if (!tokenRecord.codeChallenge) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.MISSING_CODE_CHALLENGE,
				);
			}
			if (tokenRecord.codeChallengeMethod !== "s256") {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_PKCE_METHOD,
				);
			}

			const codeChallenge = Buffer.from(
				base64Url.decode(tokenRecord.codeChallenge),
			);
			const codeVerifier = Buffer.from(
				await createHash("SHA-256").digest(ctx.body.code_verifier),
			);

			if (
				codeChallenge.length !== codeVerifier.length ||
				!timingSafeEqual(codeChallenge, codeVerifier)
			) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_CODE_VERIFIER,
				);
			}

			const user = await ctx.context.internalAdapter.findUserById(
				tokenRecord.userId,
			);
			if (!user) {
				throw APIError.from(
					"INTERNAL_SERVER_ERROR",
					BASE_ERROR_CODES.USER_NOT_FOUND,
				);
			}

			const session = await ctx.context.internalAdapter.createSession(user.id);
			if (!session) {
				throw APIError.from(
					"INTERNAL_SERVER_ERROR",
					BASE_ERROR_CODES.FAILED_TO_CREATE_SESSION,
				);
			}

			await setSessionCookie(ctx, { session, user });

			return ctx.json({
				token: session.token,
				user: parseUserOutput(ctx.context.options, user) as User &
					Record<string, any>,
			});
		},
	);

export const electrobunInitOAuthProxy = (opts: {
	clientID?: string;
	codeExpiresIn?: number;
	callback?: { url: string; hashKey?: string };
}) =>
	createAuthEndpoint(
		"/electrobun/init-oauth-proxy",
		{
			method: "GET",
			query: z.object({
				provider: z.string().nonempty(),
				state: z.string(),
				code_challenge: z.string(),
				code_challenge_method: z.string().optional(),
			}),
			metadata: { scope: "http" },
		},
		async (ctx) => {
			const isSocialProvider = SocialProviderListEnum.safeParse(
				ctx.query.provider,
			);
			if (!isSocialProvider && !ctx.context.getPlugin("generic-oauth")) {
				throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.PROVIDER_NOT_FOUND);
			}

			if (
				ctx.query.code_challenge_method &&
				ctx.query.code_challenge_method.toLowerCase() !== "s256"
			) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_PKCE_METHOD,
				);
			}

			const headers = new Headers(ctx.request?.headers);
			headers.set("origin", new URL(ctx.context.baseURL).origin);
			let setCookie: string | null = null;
			const searchParams = new URLSearchParams();
			searchParams.set("client_id", opts.clientID || "electrobun");
			searchParams.set("code_challenge", ctx.query.code_challenge);
			searchParams.set("code_challenge_method", "S256");
			searchParams.set("state", ctx.query.state);

			const body: { provider: string; callbackURL?: string } = {
				provider: ctx.query.provider,
			};
			// Cross-domain: route OAuth completion to /electrobun/oauth-complete, which
			// mints the token and redirects to the web callback.
			if (opts.callback) {
				body.callbackURL = `${ctx.context.baseURL}/electrobun/oauth-complete`;
			}

			const res = await betterFetch<{
				url: string | undefined;
				redirect: boolean;
				user?: User & Record<string, any>;
				token?: string;
			}>(
				`${isSocialProvider ? "/sign-in/social" : "/sign-in/oauth2"}?${searchParams.toString()}`,
				{
					baseURL: ctx.context.baseURL,
					method: "POST",
					body,
					onResponse: (ctx) => {
						setCookie = ctx.response.headers.get("set-cookie") ?? null;
					},
					headers,
				},
			);

			if (res.error) {
				throw new APIError("INTERNAL_SERVER_ERROR", {
					message: res.error.message || "An unknown error occurred.",
				});
			}

			if (setCookie) ctx.setHeader("set-cookie", setCookie);
			// Cross-domain: plant the transfer cookie ourselves (SameSite=None) so it
			// survives the cross-site OAuth round-trip back to /electrobun/oauth-complete.
			// setSignedCookie appends, so it coexists with the forwarded state cookie.
			if (opts.callback) {
				const cookie = ctx.context.createAuthCookie("transfer_token", {
					maxAge: opts.codeExpiresIn ?? 300,
				});
				await ctx.setSignedCookie(
					cookie.name,
					JSON.stringify({
						client_id: opts.clientID || "electrobun",
						state: ctx.query.state,
						code_challenge: ctx.query.code_challenge,
						code_challenge_method: ctx.query.code_challenge_method ?? "S256",
					}),
					ctx.context.secret,
					cookie.attributes,
				);
			}
			if (res.data.url && res.data.redirect) {
				ctx.setHeader("Location", res.data.url);
				ctx.setStatus(302);
				return;
			}
			return ctx.json(res.data);
		},
	);

type TransferPayload = {
	client_id: string;
	state: string;
	code_challenge: string;
	code_challenge_method?: string | undefined;
};

type HandleTransfer = (
	ctx: GenericEndpointContext,
	payload: TransferPayload,
) => Promise<string | null>;

// Cross-domain OAuth completion. Set as the sign-in callbackURL, so both the
// direct (/callback) and proxied (/oauth-proxy-callback) flows land here once the
// session exists. Mints the one-time code and redirects to the web callback.
export const electrobunOAuthComplete = (
	opts: { codeExpiresIn: number; callback?: { url: string; hashKey?: string } },
	{ handleTransfer }: { handleTransfer: HandleTransfer },
) =>
	createAuthEndpoint(
		"/electrobun/oauth-complete",
		{
			method: "GET",
			use: [sessionMiddleware],
			requireHeaders: true,
			metadata: { scope: "http" },
		},
		async (ctx) => {
			if (!opts.callback) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_CLIENT_ID,
				);
			}

			const cookie = ctx.context.createAuthCookie("transfer_token", {
				maxAge: opts.codeExpiresIn,
			});
			const transferCookie = await ctx.getSignedCookie(
				cookie.name,
				ctx.context.secret,
			);
			ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });

			const payload = transferCookie
				? safeJSONParse<TransferPayload>(transferCookie)
				: null;
			if (!payload) {
				throw APIError.from("BAD_REQUEST", ELECTROBUN_ERROR_CODES.MISSING_STATE);
			}

			const identifier = await handleTransfer(ctx, payload);
			if (identifier === null) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_CLIENT_ID,
				);
			}

			const redirectToken = base64Url.encode(
				new TextEncoder().encode(
					JSON.stringify({ identifier, state: payload.state }),
				),
			);
			const hashKey = opts.callback.hashKey ?? "token";
			ctx.setHeader(
				"Location",
				`${opts.callback.url}#${hashKey}=${redirectToken}`,
			);
			ctx.setStatus(302);
		},
	);

export const electrobunTransferUser = (
	_opts: unknown,
	{ handleTransfer }: { handleTransfer: HandleTransfer },
) =>
	createAuthEndpoint(
		"/electrobun/transfer-user",
		{
			method: "POST",
			query: z.object({
				client_id: z.string(),
				state: z.string(),
				code_challenge: z.string(),
				code_challenge_method: z.string().optional(),
			}),
			body: z.object({ callbackURL: z.string().optional() }),
			use: [sessionMiddleware],
			requireHeaders: true,
			metadata: { scope: "http" },
		},
		async (ctx) => {
			const identifier = await handleTransfer(ctx, ctx.query);
			if (identifier === null) {
				throw APIError.from(
					"BAD_REQUEST",
					ELECTROBUN_ERROR_CODES.INVALID_CLIENT_ID,
				);
			}
			return ctx.json({
				url: ctx.body.callbackURL ?? null,
				redirect: !!ctx.body.callbackURL,
				electrobun_authorization_code: identifier,
			});
		},
	);
