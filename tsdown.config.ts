import { defineConfig } from "tsdown";

export default defineConfig([
	{
		dts: true,
		tsconfig: "./tsconfig.build.json",
		format: ["esm"],
		plugins: [
			{
				// electrobun's browser entry does `import "./global.d.ts"` (types only);
				// map any .d.ts side-effect import to an empty runtime module.
				name: "ignore-dts-imports",
				resolveId(id: string) {
					if (id.endsWith(".d.ts")) return "\0empty-dts";
				},
				load(id: string) {
					if (id === "\0empty-dts") return "export {}";
				},
			},
		],
		entry: [
			"./src/index.ts",
			"./src/server/index.ts",
			"./src/client.ts",
			"./src/core/index.ts",
			"./src/adapters/electrobun.ts",
			"./src/adapters/electron.ts",
			"./src/web/index.ts",
			"./src/rpc/webview.ts",
		],
		treeshake: true,
		// Bundle electrobun's browser view so web consumers need no electrobun dep.
		noExternal: ["electrobun/view"],
		// Peer/runtime deps stay external; they resolve in the consumer app.
		deps: {
			neverBundle: [
				"electrobun/bun",
				"electrobun",
				"electron",
				"electron-store",
				"better-auth",
				"better-auth/client",
				"better-auth/cookies",
				"better-auth/crypto",
				"@better-auth/core",
				"@better-auth/core/db",
				"@better-auth/core/error",
				"@better-auth/utils/base64",
				"@better-auth/utils/hash",
				"@better-fetch/fetch",
				"zod",
			],
		},
	},
]);
