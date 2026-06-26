import type { BetterAuthClientOptions, ClientStore } from "@better-auth/core";
import type { User } from "@better-auth/core/db";
import type { BetterFetch } from "@better-fetch/fetch";
import { authenticate } from "./authenticate";
import type { AuthBunRPCContext, AuthSender } from "./rpc/bun";
import type { ElectrobunClientOptions } from "./types/client";
import { normalizeUserOutput } from "./user";
import { parseProtocolScheme } from "./utils";

export type SetupMainConfig = {
	getWebview?: AuthBunRPCContext["getWebview"];
};

export type SetupMainArgs = {
	$fetch: BetterFetch;
	$store: ClientStore | null;
	getCookie: () => string;
	options: ElectrobunClientOptions;
	clientOptions: BetterAuthClientOptions | undefined;
	sender: () => AuthSender | null;
	cfg?: SetupMainConfig | undefined;
};

export function subscribeToUserUpdates({
	$store,
	options,
	sender,
}: Pick<SetupMainArgs, "$store" | "options" | "sender">) {
	return $store?.atoms.session?.subscribe(async (state) => {
		if (state.isPending === true) return;

		let user: (User & Record<string, any>) | null = state.data?.user ?? null;
		if (user !== null && typeof options.sanitizeUser === "function") {
			try {
				user = await options.sanitizeUser(user);
			} catch (error) {
				console.error("Error while sanitizing user", error);
				user = null;
			}
		}
		if (user !== null) {
			user = normalizeUserOutput(user, options);
		}

		sender()?.onUserUpdated(user);
	});
}

export async function handleDeepLink({
	$fetch,
	options,
	url,
	sender,
}: {
	$fetch: BetterFetch;
	options: ElectrobunClientOptions;
	url: string;
	sender: () => AuthSender | null;
}) {
	let parsedURL: URL | null = null;
	try {
		parsedURL = new URL(url);
	} catch {}
	if (!parsedURL) return;

	const { scheme } = parseProtocolScheme(options.protocol);

	if (!url.startsWith(`${scheme}:/`)) return;
	if (parsedURL.protocol !== `${scheme}:`) return;

	const { pathname, hostname, hash } = parsedURL;
	const path = `/${hostname}${pathname}`;

	if (path !== (options.callbackPath || "/auth/callback")) return;
	if (!hash.startsWith("#token=")) return;

	const token = hash.substring("#token=".length);

	await authenticate({
		$fetch,
		options,
		token,
		notifyAuthenticated: (user) => sender()?.onAuthenticated(user),
		fetchOptions: { throw: true },
	});
}

export async function mirrorCookiesToSession(
	cookieJson: string,
	baseURL: string | undefined,
	partition = "persist:auth",
): Promise<void> {
	if (!baseURL || !cookieJson) return;
	let parsed: Record<string, { value: string; expires: string | null }>;
	try {
		parsed = JSON.parse(cookieJson) as Record<
			string,
			{ value: string; expires: string | null }
		>;
	} catch {
		return;
	}
	try {
		const { Session } = await import("electrobun/bun");
		const sess = Session.fromPartition(partition);
		const domain = new URL(baseURL).hostname;
		for (const [name, ck] of Object.entries(parsed)) {
			sess.cookies.set({
				name,
				value: ck.value,
				domain,
				path: "/",
				secure: true,
				httpOnly: true,
				sameSite: "lax",
				expirationDate: ck.expires
					? Math.floor(Date.parse(ck.expires) / 1000)
					: undefined,
			});
		}
	} catch {}
}

export async function clearSessionCookies(
	partition = "persist:auth",
): Promise<void> {
	try {
		const { Session } = await import("electrobun/bun");
		Session.fromPartition(partition).cookies.clear();
	} catch {}
}

export async function setupMain(args: SetupMainArgs) {
	const { $fetch, $store, options, sender } = args;

	const unsubSession = subscribeToUserUpdates({ $store, options, sender });

	const { default: Electrobun } = await import("electrobun/bun");

	const onOpenUrl = async (e: { data: { url: string } }) => {
		await handleDeepLink({
			$fetch,
			options,
			url: e.data.url,
			sender,
		});
	};
	Electrobun.events.on("open-url", onOpenUrl as any);

	return () => {
		unsubSession?.();
	};
}
