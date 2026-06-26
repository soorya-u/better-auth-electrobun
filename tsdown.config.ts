import { defineConfig } from "tsdown";

export default defineConfig([
	{
		dts: true,
		format: ["esm"],
		entry: [
			"./src/index.ts",
			"./src/client.ts",
			"./src/storage.ts",
			"./src/rpc/webview.ts",
		],
		treeshake: true,
		// Keep runtime/ext peer deps external; they resolve in the consumer app.
		// `electrobun/*` is consumed by the consumer's Bun-built app; never bundle it.
		deps: {
			neverBundle: [
				"electrobun/bun",
				"electrobun/view",
				"electrobun",
				"better-auth",
				"better-auth/cookies",
				"better-auth/crypto",
				"@better-auth/core",
				"@better-auth/core/db",
				"@better-auth/core/error",
				"@better-auth/utils/base64",
				"@better-auth/utils/hash",
				"@better-fetch/fetch",
				"@better-auth/electron",
				"zod",
			],
		},
	},
]);
