import builtins from "builtin-modules";
import { defineConfig } from "rolldown";

const DEFAULT_EXTERNALS = ["obsidian", "electron", ...builtins];

export function createObsidianPluginConfig(options) {
	if (!options?.input) throw new TypeError("createObsidianPluginConfig requires an input");
	const production = process.env.BUILD === "production";
	return defineConfig({
		input: options.input,
		external: [...DEFAULT_EXTERNALS, ...(options.external ?? [])],
		platform: "node",
		resolve: { tsconfigFilename: options.tsconfigFilename ?? "tsconfig.json" },
		transform: {
			define: { "process.env.NODE_ENV": production ? "'production'" : "'development'" },
		},
		output: {
			file: options.output ?? "main.js",
			format: "cjs",
			exports: "auto",
			sourcemap: production ? false : "inline",
			minify: production,
		},
	});
}
