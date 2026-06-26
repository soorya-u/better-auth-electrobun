import { randomBytes } from "node:crypto";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";
import { parseSetCookieHeader } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { beforeEach, describe, expect, vi } from "vitest";
import { authenticate, kElectrobun } from "../src/authenticate";
import { getCookie } from "../src/cookies";
import { fetchUserImage, normalizeUserOutput } from "../src/user";
import { encodeRedirectToken, it, testUtils } from "./utils";

const TEST_PKCE_VERIFIER = "test-challenge";
const TEST_PKCE_CHALLENGE = base64Url.encode(
	await createHash("SHA-256").digest(TEST_PKCE_VERIFIER),
);

const mockElectrobun = vi.hoisted(() => {
	return {
		Utils: {
			openExternal: vi.fn(() => true),
		},
		Session: {
			fromPartition: vi.fn(() => ({
				cookies: {
					set: vi.fn(() => true),
					get: vi.fn(() => []),
					clear: vi.fn(),
				},
				clearStorageData: vi.fn(),
			})),
		},
		BrowserView: {
			defineRPC: vi.fn(() => ({ send: {}, setTransport: vi.fn() })),
		},
		BrowserWindow: vi.fn(),
		default: {
			events: {
				on: vi.fn(),
				off: vi.fn(),
			},
		},
	};
});

vi.mock("electrobun/bun", () => mockElectrobun);

describe("Electrobun", () => {
	const { auth, client, proxyClient, options, get$fetch } = testUtils();

	it("should open external url in default browser", async () => {
		await client.requestAuth();

		(globalThis as any)[kElectrobun] = undefined;

		expect(mockElectrobun.Utils.openExternal).toHaveBeenCalledWith(
			expect.stringContaining(options.signInURL as string),
		);
	});

	it("should set redirect cookie after signing in", async () => {
		(globalThis as any)[kElectrobun] = new Map<string, string>([
			["abc", TEST_PKCE_VERIFIER],
		]);

		const { error } = await proxyClient.signUp.email(
			{
				email: "test@test.com",
				password: "password",
				name: "Test User",
			},
			{
				query: {
					client_id: "electron",
					code_challenge: TEST_PKCE_CHALLENGE,
					code_challenge_method: "S256",
					state: "abc",
				},
				onResponse: async (ctx) => {
					const cookies = parseSetCookieHeader(
						ctx.response.headers.get("set-cookie") || "",
					);
					const redirectCookie = cookies.get("better-auth.electron");
					expect(redirectCookie).toBeDefined();
					expect(redirectCookie?.httponly).not.toBe(true);
					expect(redirectCookie?.["max-age"]).toStrictEqual(120);
				},
				customFetchImpl: (url, init) => {
					const req = new Request(url.toString(), init);
					return auth.handler(req);
				},
			},
		);
		expect(error).toBeNull();
	});

	it("should include `electron_authorization_code` in sign-up response", async () => {
		(globalThis as any)[kElectrobun] = new Map<string, string>([
			["abc", TEST_PKCE_VERIFIER],
		]);

		const { data } = await proxyClient.signUp.email(
			{
				email: "electron-code-test@test.com",
				password: "password",
				name: "Electron Code Test",
			},
			{
				query: {
					client_id: "electron",
					code_challenge: TEST_PKCE_CHALLENGE,
					code_challenge_method: "S256",
					state: "abc",
				},
			},
		);

		expect(data).not.toBeNull();
		expect(data).toHaveProperty("electron_authorization_code");
		expect((data as any)?.electron_authorization_code).toBeTypeOf("string");
	});

	it("should exchange token", async () => {
		const { user } = await auth.api.signInEmail({
			body: { email: "test@test.com", password: "password" },
		});

		const codeVerifier = base64Url.encode(randomBytes(32));
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);

		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `electron:${identifier}`,
				value: JSON.stringify({
					userId: user.id,
					codeChallenge,
					codeChallengeMethod: "s256",
					state: "abc",
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});

		const { data } = await client.$fetch<any>("/electron/token", {
			method: "POST",
			body: { token: identifier, code_verifier: codeVerifier, state: "abc" },
			onResponse: async (ctx) => {
				const cookies = parseSetCookieHeader(
					ctx.response.headers.get("set-cookie") || "",
				);
				expect(cookies.has("better-auth.session_token")).toBe(true);
			},
		});

		expect(data?.token).toBeDefined();
		expect(data?.user.id).toBe(user.id);
	});

	it("should mint only one session for concurrent exchanges of the same code", async () => {
		const { user } = await auth.api.signUpEmail({
			body: {
				email: "concurrent-exchange@test.com",
				password: "password",
				name: "Concurrent Exchange",
			},
		});

		const codeVerifier = base64Url.encode(randomBytes(32));
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);

		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `electron:${identifier}`,
				value: JSON.stringify({
					userId: user.id,
					codeChallenge,
					codeChallengeMethod: "s256",
					state: "abc",
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});

		const exchange = () =>
			client.$fetch<any>("/electron/token", {
				method: "POST",
				body: { token: identifier, code_verifier: codeVerifier, state: "abc" },
			});

		const results = await Promise.all([exchange(), exchange()]);
		const succeeded = results.filter((r) => r.data?.token);
		const failed = results.filter((r) => r.error);

		expect(succeeded).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.error?.status).toBe(404);
	});

	it("should call notifyAuthenticated on successful token exchange", async () => {
		const notifyAuthenticated = vi.fn();

		const { user } = await auth.api.signInEmail({
			body: { email: "test@test.com", password: "password" },
		});

		const codeVerifier = base64Url.encode(randomBytes(32));
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);

		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `electron:${identifier}`,
				value: JSON.stringify({
					userId: user.id,
					codeChallenge,
					codeChallengeMethod: "s256",
					state: "abc",
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});

		const token = encodeRedirectToken(identifier, "abc");
		(globalThis as any)[kElectrobun] = new Map([["abc", codeVerifier]]);

		await authenticate({
			$fetch: get$fetch(),
			options: { ...options, signInURL: options.signInURL as string },
			token,
			notifyAuthenticated,
			fetchOptions: { throw: true },
		});

		expect(notifyAuthenticated).toHaveBeenCalledWith(
			expect.objectContaining({ id: user.id }),
		);
	});

	it("should handle deep link and exchange token", async () => {
		const { user } = await auth.api.signUpEmail({
			body: {
				email: "deeplink@test.com",
				password: "password",
				name: "Deep Link",
			},
		});

		const codeVerifier = base64Url.encode(randomBytes(32));
		const codeChallenge = base64Url.encode(
			await createHash("SHA-256").digest(codeVerifier),
		);

		const identifier = generateRandomString(16, "A-Z", "a-z", "0-9");
		await (await auth.$context).adapter.create({
			model: "verification",
			data: {
				identifier: `electron:${identifier}`,
				value: JSON.stringify({
					userId: user.id,
					codeChallenge,
					codeChallengeMethod: "s256",
					state: "deeplink-state",
				}),
				expiresAt: new Date(Date.now() + 300 * 1000),
			},
		});

		const token = encodeRedirectToken(identifier, "deeplink-state");
		(globalThis as any)[kElectrobun] = new Map([
			["deeplink-state", codeVerifier],
		]);

		const notified = vi.fn();

		const { handleDeepLink } = await import("../src/setup");
		await handleDeepLink({
			$fetch: get$fetch(),
			options: { ...options, signInURL: options.signInURL as string },
			url: `myapp://auth/callback#token=${token}`,
			sender: () => ({
				onAuthenticated: notified,
				onUserUpdated: vi.fn(),
				onAuthError: vi.fn(),
			}),
		});

		expect(notified).toHaveBeenCalledWith(
			expect.objectContaining({ id: user.id }),
		);
	});
});

describe("cookies getCookie", () => {
	it("serializes stored cookies into a Cookie header string", () => {
		const stored = JSON.stringify({
			"better-auth.session_token": { value: "abc", expires: null },
		});
		expect(getCookie(stored)).toBe("better-auth.session_token=abc");
	});

	it("joins multiple stored cookies with `; `", () => {
		const stored = JSON.stringify({
			a: { value: "1", expires: null },
			b: { value: "2", expires: null },
		});
		expect(getCookie(stored)).toBe("a=1; b=2");
	});

	it("percent-encodes reserved cookie-octet bytes", () => {
		const stored = JSON.stringify({
			session: { value: "safe", expires: null },
			pref: { value: "foo;bar=baz", expires: null },
		});
		expect(getCookie(stored)).toBe("session=safe; pref=foo%3Bbar%3Dbaz");
	});

	it("skips entries whose name violates the cookie-name token", () => {
		const stored = JSON.stringify({
			session: { value: "safe", expires: null },
			"bad name": { value: "x", expires: null },
		});
		expect(getCookie(stored)).toBe("session=safe");
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
	const MINIMAL_PNG_BASE64 = Buffer.from(MINIMAL_PNG).toString("base64");

	const mockFetch = vi.fn();

	beforeEach(() => {
		vi.stubGlobal("fetch", mockFetch);
		mockFetch.mockImplementation(async (url: string) => {
			if (url.endsWith("-fail.png")) {
				return new Response(null, { status: 404 });
			}
			if (url.endsWith(".png")) {
				return new Response(MINIMAL_PNG.buffer, {
					headers: new Headers({ "content-type": "image/png" }),
				});
			}
			if (url.endsWith(".jpg") || url.endsWith(".jpeg")) {
				return new Response(new Uint8Array([0xff, 0xd8, 0xff]).buffer, {
					headers: new Headers({ "content-type": "image/jpeg" }),
				});
			}
			if (url.endsWith(".html")) {
				return new Response("<html/>", {
					headers: new Headers({ "content-type": "text/html" }),
				});
			}
			return new Response(null, { status: 404 });
		});
	});

	it("normalizeUserOutput should return user unchanged", () => {
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

	it("should decode valid data URL", async () => {
		const dataUrl = `data:image/png;base64,${MINIMAL_PNG_BASE64}`;
		const result = await fetchUserImage(undefined, dataUrl);
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
	});

	it("should reject SVG data URL", async () => {
		const result = await fetchUserImage(
			undefined,
			"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
		);
		expect(result).toBeNull();
	});

	it("should fetch http URL", async () => {
		const result = await fetchUserImage(
			undefined,
			"https://example.com/avatar.png",
		);
		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.com/avatar.png",
			expect.objectContaining({ method: "GET" }),
		);
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
	});

	it("should return null when fetch fails", async () => {
		const result = await fetchUserImage(
			undefined,
			"https://example.com/avatar-fail.png",
		);
		expect(result).toBeNull();
	});

	it("should return null for non-image content-type", async () => {
		const result = await fetchUserImage(
			undefined,
			"https://example.com/page.html",
		);
		expect(result).toBeNull();
	});

	it("should fetch JPEG", async () => {
		const result = await fetchUserImage(
			undefined,
			"https://example.com/avatar.jpg",
		);
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/jpeg");
	});
});
