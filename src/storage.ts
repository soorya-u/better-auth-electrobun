import type { Storage } from "./types/client";

// `Bun.secrets` is not yet in @types/bun 1.3.x — declare locally.
type BunSecrets = {
	get(opts: { service: string; name: string }): Promise<string | null>;
	set(opts: { service: string; name: string }, value: string): Promise<void>;
	delete(opts: { service: string; name: string }): Promise<boolean>;
};

export type StorageOptions = {
	/** Keychain service name. @default "better-auth-electrobun" */
	service?: string | undefined;
	/** Keychain account name for the session blob. @default "session" */
	account?: string | undefined;
};

export async function storage(opts: StorageOptions = {}): Promise<Storage> {
	const { service = "better-auth-electrobun", account = "session" } = opts;
	const secrets = (Bun as unknown as { secrets: BunSecrets }).secrets;

	let cache: Record<string, unknown> = {};
	try {
		const raw = await secrets.get({ service, name: account });
		if (raw) cache = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		cache = {};
	}

	const persist = () => {
		void secrets.set({ service, name: account }, JSON.stringify(cache));
	};

	return {
		getItem: (name) => {
			const v = cache[name];
			return v === undefined ? null : v;
		},
		setItem: (name, value) => {
			cache[name] = value;
			persist();
		},
	};
}

export async function storageForTests(): Promise<Storage> {
	return storage({ service: `better-auth-electrobun-test-${process.pid}` });
}
