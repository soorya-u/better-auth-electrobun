import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import { parseSetCookieHeader } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { beforeEach, describe, expect, vi } from "vitest";
import { getCookie } from "../src/core/cookies";
import { startAuthFlow } from "../src/core/exchange";
import {
	buildLoopbackUrl,
	generateNonce,
	isAllowedLoopbackPort,
	parseLoopbackUrl,
} from "../src/core/loopback";
import { fetchUserImage, normalizeUserOutput } from "../src/core/user";
import {
	CLIENT_ID,
	encodeRedirectToken,
	it,
	mockAdapter,
	testUtils,
} from "./utils";

describe("loopback url helpers", () => {
	it("builds a 127.0.0.1 loopback url with the nonce", () => {
		const url = buildLoopbackUrl(51789, "/callback", "abc");
		expect(url).toBe("http://127.0.0.1:51789/callback?nonce=abc");
	});

	it("accepts a plain-http 127.0.0.1 url", () => {
		expect(
			parseLoopbackUrl("http://127.0.0.1:51789/callback?nonce=x"),
		).not.toBe(null);
	});

	it("rejects the localhost hostname, https, and other hosts", () => {
		expect(parseLoopbackUrl("http://localhost:51789/callback")).toBe(null);
		expect(parseLoopbackUrl("https://127.0.0.1:51789/callback")).toBe(null);
		expect(parseLoopbackUrl("http://10.0.0.1:51789/callback")).toBe(null);
		expect(parseLoopbackUrl("not a url")).toBe(null);
	});

	it("enforces an allowed-port range", () => {
		const range = { min: 51000, max: 52000 };
		expect(parseLoopbackUrl("http://127.0.0.1:51789/cb", range)).not.toBe(null);
		expect(parseLoopbackUrl("http://127.0.0.1:8080/cb", range)).toBe(null);
		expect(isAllowedLoopbackPort(51789, [51789])).toBe(true);
		expect(isAllowedLoopbackPort(8080, [51789])).toBe(false);
	});

	it("generates distinct nonces", () => {
		expect(generateNonce()).not.toBe(generateNonce());
	});
});

describe("desktop server", () => {
	const { auth } = testUtils();

	const req = (path: string, init?: RequestInit) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				headers: { origin: "http://localhost:3000" },
				...init,
			}),
		);

	it("init-oauth-proxy rejects a non-loopback callbackURL", async () => {
		const params = new URLSearchParams({
			provider: "google",
			state: "abc",
			code_challenge: "challenge",
			callbackURL: "https://evil.example.com/callback",
		});
		const res = await req(`/desktop/init-oauth-proxy?${params.toString()}`);
		expect(res.status).toBe(400);
	});
});

describe("desktop token exchange", () => {
	const { auth } = testUtils();

	const seedCode = async (opts: {
		userId: string;
		codeChallenge: string;
		state: string;
	}) => {
		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `desktop:${identifier}`,
				value: JSON.stringify({
					userId: opts.userId,
					codeChallenge: opts.codeChallenge,
					codeChallengeMethod: "s256",
					state: opts.state,
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});
		return identifier;
	};

	it("exchanges a one-time code for a session at /desktop/token", async () => {
		const { user } = await auth.api.signUpEmail({
			body: { email: "exchange@test.com", password: "password", name: "X" },
		});
		const codeVerifier = base64Url.encode(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);
		const identifier = await seedCode({
			userId: user.id,
			codeChallenge,
			state: "abc",
		});

		const res = await auth.handler(
			new Request("http://localhost:3000/api/auth/desktop/token", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					token: identifier,
					state: "abc",
					code_verifier: codeVerifier,
				}),
			}),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { token: string; user: { id: string } };
		expect(data.token).toBeDefined();
		expect(data.user.id).toBe(user.id);
		expect(
			parseSetCookieHeader(res.headers.get("set-cookie") || "").has(
				"better-auth.session_token",
			),
		).toBe(true);
	});

	it("rejects a wrong PKCE verifier", async () => {
		const { user } = await auth.api.signUpEmail({
			body: { email: "badpkce@test.com", password: "password", name: "X" },
		});
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest("the-real-verifier"),
		);
		const identifier = await seedCode({
			userId: user.id,
			codeChallenge,
			state: "abc",
		});

		const res = await auth.handler(
			new Request("http://localhost:3000/api/auth/desktop/token", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					token: identifier,
					state: "abc",
					code_verifier: "a-different-verifier",
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("mints only one session for concurrent exchanges of the same code", async () => {
		const { user } = await auth.api.signUpEmail({
			body: { email: "concurrent@test.com", password: "password", name: "X" },
		});
		const codeVerifier = base64Url.encode(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);
		const identifier = await seedCode({
			userId: user.id,
			codeChallenge,
			state: "abc",
		});

		const exchange = () =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/desktop/token", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
					},
					body: JSON.stringify({
						token: identifier,
						state: "abc",
						code_verifier: codeVerifier,
					}),
				}),
			);

		const results = await Promise.all([exchange(), exchange()]);
		const ok = results.filter((r) => r.status === 200);
		const failed = results.filter((r) => r.status === 404);
		expect(ok).toHaveLength(1);
		expect(failed).toHaveLength(1);
	});
});

describe("loopback auth flow (end-to-end via mock adapter)", () => {
	const { auth, internals, storage } = testUtils();

	const driveFlow = async () => {
		const { adapter, events, hit, openedUrl } = mockAdapter(storage);
		await startAuthFlow({
			adapter,
			$fetch: internals.$fetch,
			clientOptions: internals.clientOptions,
			options: { clientID: CLIENT_ID },
			cfg: { provider: "google" },
			onAuthenticated: (user) =>
				adapter.notifyRenderer({ type: "authenticated", user }),
		});

		// Parse the init URL the "browser" was sent to.
		const init = new URL(openedUrl());
		const state = init.searchParams.get("state") as string;
		const codeChallenge = init.searchParams.get("code_challenge") as string;
		const loopback = new URL(init.searchParams.get("callbackURL") as string);
		const nonce = loopback.searchParams.get("nonce") as string;
		return { events, hit, state, codeChallenge, nonce };
	};

	const seedCodeFor = async (codeChallenge: string, state: string) => {
		const { user } = await auth.api.signUpEmail({
			body: {
				email: `flow-${state}@test.com`,
				password: "password",
				name: "Flow",
			},
		});
		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `desktop:${identifier}`,
				value: JSON.stringify({
					userId: user.id,
					codeChallenge,
					codeChallengeMethod: "s256",
					state,
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});
		return { user, identifier };
	};

	it("completes the loopback hit and notifies the renderer", async () => {
		const { events, hit, state, codeChallenge, nonce } = await driveFlow();
		const { user, identifier } = await seedCodeFor(codeChallenge, state);

		const res = await hit({
			path: "/callback",
			query: { nonce, token: encodeRedirectToken(identifier, state) },
		});

		expect(res.status).toBe(200);
		expect(res.body).toContain("Signed in");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "authenticated",
				user: expect.objectContaining({ id: user.id }),
			}),
		);
	});

	it("rejects a wrong nonce", async () => {
		const { hit } = await driveFlow();
		const res = await hit({
			path: "/callback",
			query: { nonce: "wrong", token: "whatever" },
		});
		expect(res.status).toBe(403);
	});

	it("ignores unknown paths", async () => {
		const { hit, nonce } = await driveFlow();
		const res = await hit({ path: "/evil", query: { nonce, token: "x" } });
		expect(res.status).toBe(404);
	});

	it("fails a replayed code (verifier already consumed)", async () => {
		const { hit, state, codeChallenge, nonce } = await driveFlow();
		const { identifier } = await seedCodeFor(codeChallenge, state);
		const query = { nonce, token: encodeRedirectToken(identifier, state) };

		const first = await hit({ path: "/callback", query });
		expect(first.status).toBe(200);
		const second = await hit({ path: "/callback", query });
		expect(second.status).toBe(500);
	});
});

describe("cookies getCookie", () => {
	it("serializes stored cookies into a Cookie header string", () => {
		const stored = JSON.stringify({
			"better-auth.session_token": { value: "abc", expires: null },
		});
		expect(getCookie(stored)).toBe("better-auth.session_token=abc");
	});

	it("skips expired entries", () => {
		const stored = JSON.stringify({
			session: { value: "abc", expires: new Date(0).toISOString() },
		});
		expect(getCookie(stored)).toBe("");
	});
});

describe("fetchUserImage", () => {
	const MINIMAL_PNG = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	]);
	const mockFetch = vi.fn();

	beforeEach(() => {
		vi.stubGlobal("fetch", mockFetch);
		mockFetch.mockImplementation(async (url: string) => {
			if (url.endsWith(".png")) {
				return new Response(MINIMAL_PNG.buffer, {
					headers: new Headers({ "content-type": "image/png" }),
				});
			}
			return new Response(null, { status: 404 });
		});
	});

	it("normalizeUserOutput returns the user unchanged", () => {
		const user = normalizeUserOutput({
			id: "abc123",
			name: "Test",
			email: "test@test.com",
			image: "https://example.com/avatar.png",
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		expect(user.image).toBe("https://example.com/avatar.png");
	});

	it("fetches an http image", async () => {
		const result = await fetchUserImage(
			undefined,
			"https://example.com/avatar.png",
		);
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
	});

	it("rejects an SVG data URL", async () => {
		const result = await fetchUserImage(
			undefined,
			"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
		);
		expect(result).toBeNull();
	});
});
