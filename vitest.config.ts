import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		clearMocks: true,
		restoreMocks: true,
		server: {
			deps: {
				external: ["electrobun", "electrobun/bun", "electrobun/view"],
			},
		},
	},
});
