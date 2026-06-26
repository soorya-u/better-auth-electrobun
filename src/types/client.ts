import type { Awaitable } from "@better-auth/core";
import type { User } from "@better-auth/core/db";
import type { ElectronSharedOptions } from "./options";

export type Storage = {
	getItem: (name: string) => unknown | null;
	setItem: (name: string, value: unknown) => void;
};

export interface ElectrobunSharedClientOptions extends ElectronSharedOptions {
	protocol:
		| string
		| {
				scheme: string;
		  };
	callbackPath?: string;
}

export interface ElectrobunClientOptions extends ElectrobunSharedClientOptions {
	signInURL: string | URL;
	storage: Storage;
	storagePrefix?: string | undefined;
	sanitizeUser?:
		| ((
				user: User & Record<string, any>,
		  ) => Awaitable<User & Record<string, any>>)
		| undefined;
	cookiePrefix?: string | string[] | undefined;
	disableCache?: boolean | undefined;
	/** Electrobun session partition to mirror cookies into. @default "persist:auth" */
	sessionPartition?: string | undefined;
	userImageProxy?: boolean | undefined;
}

export type * from "./auth";
export type { ElectronSharedOptions };
