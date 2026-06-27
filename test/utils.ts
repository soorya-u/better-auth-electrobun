import { base64Url } from "@better-auth/utils/base64";
import type { BetterFetch } from "@better-fetch/fetch";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import type { FetchEsque } from "better-auth/client";
import { createAuthClient } from "better-auth/client";
import { getMigrations } from "better-auth/db/migration";
import { oAuthProxy } from "better-auth/plugins";
import Database from "better-sqlite3";
import { afterAll, beforeAll, test } from "vitest";
import type { DesktopClientInternals } from "../src/core/client";
import { desktopClient } from "../src/core/client";
import type {
	AuthEvent,
	DesktopAdapter,
	LoopbackRequest,
	LoopbackResponse,
	Storage,
} from "../src/core/types";
import { betterAuthDesktop } from "../src/server";

export const it = test;

export const CLIENT_ID = "test-desktop";

function getTestInstance(overrideOpts?: BetterAuthOptions) {
	const store = new Map<string, string>();
	const storage: Storage = {
		getItem: (name) => store.get(name) ?? null,
		setItem: (name, value) => {
			store.set(name, String(value));
		},
	};

	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: new Database(":memory:"),
		emailAndPassword: { enabled: true },
		socialProviders: {
			google: { clientId: "test", clientSecret: "test" },
		},
		plugins: [betterAuthDesktop({ clientID: CLIENT_ID }), oAuthProxy()],
		trustedOrigins: ["http://localhost:3000"],
		...(overrideOpts ?? {}),
	});

	const customFetchImpl: FetchEsque = (url, init) => {
		const req = new Request(url.toString(), init);
		return auth.handler(req);
	};

	let capturedFetch: BetterFetch | null = null;
	const client = createAuthClient({
		baseURL: "http://localhost:3000",
		fetchOptions: { customFetchImpl },
		plugins: [
			desktopClient({ storage, clientID: CLIENT_ID }),
			{
				id: "capture-fetch",
				getActions: ($fetch: BetterFetch) => {
					capturedFetch = $fetch;
					return {};
				},
			},
		],
	});

	const internals =
		client.getDesktopInternals() as unknown as DesktopClientInternals;

	const get$fetch = () => {
		if (!capturedFetch) throw new Error("$fetch not initialized");
		return capturedFetch;
	};

	return {
		auth,
		client,
		internals,
		storage,
		store,
		customFetchImpl,
		get$fetch,
	};
}

export function testUtils(overrideOpts?: BetterAuthOptions) {
	const testInstance = getTestInstance(overrideOpts);

	beforeAll(async () => {
		const { runMigrations } = await getMigrations(testInstance.auth.options);
		await runMigrations();
	});

	afterAll(() => {});

	return testInstance;
}

export function encodeRedirectToken(identifier: string, state: string) {
	return base64Url.encode(
		new TextEncoder().encode(JSON.stringify({ identifier, state })),
	);
}

// In-memory adapter that captures the loopback handler and the opened URL so a
// test can drive the loopback hit synchronously.
export function mockAdapter(storage: Storage) {
	let onRequest: ((req: LoopbackRequest) => Promise<LoopbackResponse>) | null =
		null;
	let openedUrl = "";
	let closed = false;
	const events: AuthEvent[] = [];

	const adapter: DesktopAdapter = {
		openExternal: (url) => {
			openedUrl = url;
		},
		serveLoopback: async (handler) => {
			onRequest = handler;
			return {
				port: 51789,
				close: () => {
					closed = true;
				},
			};
		},
		notifyRenderer: (event) => {
			events.push(event);
		},
		storage,
	};

	return {
		adapter,
		events,
		hit: (req: LoopbackRequest) => {
			if (!onRequest) throw new Error("loopback not started");
			return onRequest(req);
		},
		openedUrl: () => openedUrl,
		isClosed: () => closed,
	};
}
