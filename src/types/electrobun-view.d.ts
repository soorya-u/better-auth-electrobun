/**
 * Minimal type stub for `electrobun/view`.
 *
 * Kept separate from the bun stub because the view module lives in a different
 * rendering context (DOM) and the path override must resolve to a distinct file.
 */
export declare class Electroview {
	constructor(config: { rpc: any });
	static defineRPC<T>(opts: {
		maxRequestTime?: number;
		handlers: { requests: Record<string, any>; messages: Record<string, any> };
	}): any;
}
