import type { Storage } from "./types";

export type KeychainStorageOptions = {
	service?: string | undefined;
	account?: string | undefined;
};

// Loads the keychain blob once via Bun.secrets, then serves a synchronous cache.
// Bun-specific; the Electron adapter supplies its own keychain-backed Storage.
export async function keychainStorage(
	opts: KeychainStorageOptions = {},
): Promise<Storage> {
	const { service = "better-auth-desktop", account = "session" } = opts;

	let cache: Record<string, unknown> = {};
	try {
		const raw = await Bun.secrets.get({ service, name: account });
		if (raw) cache = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		cache = {};
	}

	const persist = () => {
		Bun.secrets
			.set({ service, name: account, value: JSON.stringify(cache) })
			.catch(() => undefined);
	};

	return {
		getItem: (name) => cache[name] ?? null,
		setItem: (name, value) => {
			cache[name] = value;
			persist();
		},
	};
}
