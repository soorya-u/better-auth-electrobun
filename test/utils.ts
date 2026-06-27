import type { BetterAuthClientPlugin } from "@better-auth/core";
import { base64Url } from "@better-auth/utils/base64";
import type { BetterFetch } from "@better-fetch/fetch";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import type { FetchEsque } from "better-auth/client";
import { createAuthClient } from "better-auth/client";
import { getMigrations } from "better-auth/db/migration";
import { oAuthProxy } from "better-auth/plugins";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { electrobunClient } from "../src/client";
import { electrobun, electrobunProxyClient } from "../src/index";
import type { ElectrobunClientOptions } from "../src/types/client";

export const it = test;

function getTestInstance(overrideOpts?: BetterAuthOptions) {
	const storage = new Map<string, any>();
	const options = {
		signInURL: "http://localhost:3000/sign-in",
		protocol: {
			scheme: "myapp",
		},
		storage: {
			getItem: (name: string) => storage.get(name) ?? null,
			setItem: (name: string, value: unknown) => {
				storage.set(name, value);
			},
		},
	} satisfies ElectrobunClientOptions;

	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: new Database(":memory:"),
		emailAndPassword: { enabled: true },
		socialProviders: {
			google: { clientId: "test", clientSecret: "test" },
		},
		plugins: [electrobun(), oAuthProxy()],
		trustedOrigins: ["myapp:/"],
		...(overrideOpts ?? {}),
	});

	const customFetchImpl: FetchEsque = (url, init) => {
		const req = new Request(url.toString(), init);
		return auth.handler(req);
	};

	const proxyClient = createAuthClient({
		baseURL: "http://localhost:3000",
		fetchOptions: { customFetchImpl },
		plugins: [electrobunProxyClient(options)],
	});

	let capturedFetch: BetterFetch | null = null;
	const client = createAuthClient({
		baseURL: "http://localhost:3000",
		fetchOptions: { customFetchImpl },
		plugins: [
			electrobunClient(options),
			{
				id: "capture-fetch",
				getActions: ($fetch: BetterFetch) => {
					capturedFetch = $fetch;
					return {};
				},
			} satisfies BetterAuthClientPlugin,
		],
	});

	const get$fetch = () => {
		if (!capturedFetch) throw new Error("$fetch not initialized");
		return capturedFetch;
	};

	return {
		auth,
		proxyClient,
		client,
		options,
		customFetchImpl,
		storage,
		get$fetch,
	};
}

export function testUtils(overrideOpts?: BetterAuthOptions) {
	const testInstance = getTestInstance(overrideOpts);

	beforeAll(async () => {
		const { runMigrations } = await getMigrations(testInstance.auth.options);
		await runMigrations();
	});

	afterEach(() => {
		testInstance.storage.clear();
	});

	afterAll(() => {});

	return testInstance;
}

export function encodeRedirectToken(identifier: string, state: string) {
	return base64Url.encode(
		new TextEncoder().encode(JSON.stringify({ identifier, state })),
	);
}
