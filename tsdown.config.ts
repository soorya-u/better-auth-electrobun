import { defineConfig } from "tsdown";

export default defineConfig([
	{
		dts: true,
		format: ["esm"],
		plugins: [
			{
				name: "rewrite-worker-url",
				renderChunk(code, chunk) {
					if (chunk.fileName === "storage.mjs") {
						return { code: code.replace('"./worker.ts"', '"./worker.mjs"') };
					}
				},
			},
		],
		entry: [
			"./src/index.ts",
			"./src/client.ts",
			"./src/storage.ts",
			"./src/worker.ts",
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
