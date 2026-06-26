/**
 * Minimal type stubs for `electrobun/bun` and `electrobun`.
 *
 * The tsconfig paths map these two entry points here so tsc never descends
 * into the raw Electrobun `.ts` sources (which require FFI/DOM globals that
 * are not available in the library's `"lib": ["ESNext"]` config).
 *
 * Only the symbols actually referenced in `src/` are declared. Cast to
 * `unknown` at call sites when the full Electrobun API is needed.
 */

export declare namespace BrowserView {
	function defineRPC<T>(opts: {
		maxRequestTime?: number;
		handlers: { requests: Record<string, any>; messages: Record<string, any> };
	}): any;
}

export declare class BrowserWindow {
	readonly webview: { id: number } | undefined;
	readonly rpc: any;
	constructor(opts: {
		title?: string;
		url?: string;
		rpc?: any;
		frame?: { width?: number; height?: number; x?: number; y?: number };
	});
}

export declare const Utils: {
	openExternal(url: string): boolean;
};

export declare const Session: {
	fromPartition(partition: string): {
		cookies: {
			set(cookie: {
				name: string;
				value: string;
				domain?: string;
				path?: string;
				secure?: boolean;
				httpOnly?: boolean;
				sameSite?: "no_restriction" | "lax" | "strict";
				expirationDate?: number;
			}): boolean;
			get(filter?: Record<string, unknown>): Array<Record<string, unknown>>;
			clear(): void;
		};
		clearStorageData(types?: string[] | "all"): void;
	};
};

declare const Electrobun: {
	events: {
		on(event: string, handler: (e: any) => any): void;
		off(event: string, handler: (e: any) => any): void;
	};
};
export default Electrobun;
