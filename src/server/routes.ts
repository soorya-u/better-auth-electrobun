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
import { parseLoopbackUrl } from "../core/loopback";
import { DESKTOP_ERROR_CODES } from "./error-codes";
import type { ResolvedServerOptions } from "./types";

export const desktopToken = (_opts: ResolvedServerOptions) =>
	createAuthEndpoint(
		"/desktop/token",
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
				`desktop:${ctx.body.token}`,
			);
			if (!token) {
				throw APIError.from("NOT_FOUND", DESKTOP_ERROR_CODES.INVALID_TOKEN);
			}

			const tokenRecord = safeJSONParse<Record<string, any>>(token.value);
			if (!tokenRecord) {
				throw APIError.from(
					"INTERNAL_SERVER_ERROR",
					DESKTOP_ERROR_CODES.INVALID_TOKEN,
				);
			}

			if (tokenRecord.state !== ctx.body.state) {
				throw APIError.from("BAD_REQUEST", DESKTOP_ERROR_CODES.STATE_MISMATCH);
			}
			if (!tokenRecord.codeChallenge) {
				throw APIError.from(
					"BAD_REQUEST",
					DESKTOP_ERROR_CODES.MISSING_CODE_CHALLENGE,
				);
			}
			if (tokenRecord.codeChallengeMethod !== "s256") {
				throw APIError.from(
					"BAD_REQUEST",
					DESKTOP_ERROR_CODES.INVALID_PKCE_METHOD,
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
					DESKTOP_ERROR_CODES.INVALID_CODE_VERIFIER,
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

export const desktopInitOAuthProxy = (opts: ResolvedServerOptions) =>
	createAuthEndpoint(
		"/desktop/init-oauth-proxy",
		{
			method: "GET",
			query: z.object({
				provider: z.string().nonempty(),
				state: z.string(),
				code_challenge: z.string(),
				code_challenge_method: z.string().optional(),
				// Loopback destination supplied by the desktop adapter (RFC 8252).
				callbackURL: z.string().nonempty(),
			}),
			metadata: { scope: "http" },
		},
		async (ctx) => {
			const loopback = parseLoopbackUrl(
				ctx.query.callbackURL,
				opts.allowedLoopbackPorts,
			);
			if (!loopback) {
				throw APIError.from(
					"BAD_REQUEST",
					DESKTOP_ERROR_CODES.INVALID_LOOPBACK_URL,
				);
			}

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
					DESKTOP_ERROR_CODES.INVALID_PKCE_METHOD,
				);
			}

			const headers = new Headers(ctx.request?.headers);
			headers.set("origin", new URL(ctx.context.baseURL).origin);
			let setCookie: string | null = null;
			const searchParams = new URLSearchParams();
			searchParams.set("client_id", opts.clientID);
			searchParams.set("code_challenge", ctx.query.code_challenge);
			searchParams.set("code_challenge_method", "S256");
			searchParams.set("state", ctx.query.state);

			// Route OAuth completion through /desktop/oauth-complete, carrying the
			// loopback destination so it can mint the token and redirect there.
			const completeURL = new URL(
				`${ctx.context.baseURL}/desktop/oauth-complete`,
			);
			completeURL.searchParams.set("redirect", loopback.toString());

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
					body: {
						provider: ctx.query.provider,
						callbackURL: completeURL.toString(),
					},
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
			// Plant the transfer cookie ourselves (SameSite=None) so the PKCE payload
			// survives the cross-site OAuth round-trip back to /desktop/oauth-complete.
			const cookie = ctx.context.createAuthCookie("transfer_token", {
				maxAge: opts.codeExpiresIn,
			});
			await ctx.setSignedCookie(
				cookie.name,
				JSON.stringify({
					client_id: opts.clientID,
					state: ctx.query.state,
					code_challenge: ctx.query.code_challenge,
					code_challenge_method: ctx.query.code_challenge_method ?? "S256",
				}),
				ctx.context.secret,
				cookie.attributes,
			);
			if (res.data.url && res.data.redirect) {
				ctx.setHeader("Location", res.data.url);
				ctx.setStatus(302);
				return;
			}
			return ctx.json(res.data);
		},
	);

export type TransferPayload = {
	client_id: string;
	state: string;
	code_challenge: string;
	code_challenge_method?: string | undefined;
};

export type HandleTransfer = (
	ctx: GenericEndpointContext,
	payload: TransferPayload,
) => Promise<string | null>;

// OAuth completion endpoint. Set as the sign-in callbackURL, so both the direct
// (/callback) and proxied (/oauth-proxy-callback) flows land here once the
// session exists. Mints the one-time code and redirects to the desktop loopback
// (default) or to the branded web callback page (when webCallbackUrl is set).
export const desktopOAuthComplete = (
	opts: ResolvedServerOptions,
	{ handleTransfer }: { handleTransfer: HandleTransfer },
) =>
	createAuthEndpoint(
		"/desktop/oauth-complete",
		{
			method: "GET",
			query: z.object({ redirect: z.string().nonempty() }),
			use: [sessionMiddleware],
			requireHeaders: true,
			metadata: { scope: "http" },
		},
		async (ctx) => {
			const loopback = parseLoopbackUrl(
				ctx.query.redirect,
				opts.allowedLoopbackPorts,
			);
			if (!loopback) {
				throw APIError.from(
					"BAD_REQUEST",
					DESKTOP_ERROR_CODES.INVALID_LOOPBACK_URL,
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
				throw APIError.from("BAD_REQUEST", DESKTOP_ERROR_CODES.MISSING_STATE);
			}

			const identifier = await handleTransfer(ctx, payload);
			if (identifier === null) {
				throw APIError.from(
					"BAD_REQUEST",
					DESKTOP_ERROR_CODES.INVALID_CLIENT_ID,
				);
			}

			const redirectToken = base64Url.encode(
				new TextEncoder().encode(
					JSON.stringify({ identifier, state: payload.state }),
				),
			);

			if (opts.webCallbackUrl) {
				// Branded path: hand the token + loopback to the web page, which calls
				// forwardToDesktop() to perform the top-level navigation to 127.0.0.1.
				ctx.setHeader(
					"Location",
					`${opts.webCallbackUrl}#${opts.hashKey}=${redirectToken}&loopback=${encodeURIComponent(loopback.toString())}`,
				);
				ctx.setStatus(302);
				return;
			}

			// Default path: redirect the browser straight to the loopback.
			loopback.searchParams.set(opts.hashKey, redirectToken);
			ctx.setHeader("Location", loopback.toString());
			ctx.setStatus(302);
		},
	);
