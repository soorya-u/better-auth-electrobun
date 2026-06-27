import type { User } from "@better-auth/core/db";
import type { BetterFetchError } from "@better-fetch/fetch";
import type { RequestAuthOptions } from "../core/types";

export type RPCSchema<
	T extends { requests?: any; messages?: any } | undefined = undefined,
> = [T] extends [undefined]
	? { requests: Record<string, any>; messages: Record<string, any> }
	: NonNullable<T>;

export type DesktopRPCSchema = {
	bun: RPCSchema;
	webview: RPCSchema;
};

export type AuthBunRequests = {
	getUser: {
		params: Record<never, never>;
		response: (User & Record<string, any>) | null;
	};
	requestAuth: {
		params: { options: RequestAuthOptions };
		response: undefined;
	};
	signOut: {
		params: Record<never, never>;
		response: undefined;
	};
	getUserImage: {
		params: { url: string };
		response: { dataUrl: string | null };
	};
};

export type AuthWebviewMessages = {
	onAuthenticated: User & Record<string, any>;
	onUserUpdated: (User & Record<string, any>) | null;
	onAuthError: {
		error: BetterFetchError | { message: string };
		path?: string;
	};
};

export type DesktopAuthRPC = DesktopRPCSchema & {
	bun: {
		requests: AuthBunRequests;
		messages: Record<never, never>;
	};
	webview: {
		requests: Record<never, never>;
		messages: AuthWebviewMessages;
	};
};

export type AuthBridges = {
	getUser(): Promise<(User & Record<string, any>) | null>;
	requestAuth(options: RequestAuthOptions): Promise<void>;
	signOut(): Promise<void>;
	getUserImage(url: string): Promise<{ dataUrl: string | null }>;
	onAuthenticated(
		callback: (user: User & Record<string, any>) => void,
	): () => void;
	onUserUpdated(
		callback: (user: (User & Record<string, any>) | null) => void,
	): () => void;
	onAuthError(
		callback: (context: {
			error: BetterFetchError | { message: string };
			path?: string;
		}) => void,
	): () => void;
};

export type ExposedBridges = AuthBridges;
