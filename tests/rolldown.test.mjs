import assert from "node:assert/strict";
import test from "node:test";
import { createObsidianPluginConfig } from "../src/rolldown.mjs";

test("configures a CommonJS bundle and externals for Obsidian", () => {
	const config = createObsidianPluginConfig({
		input: "src/main.ts",
		external: [/^@codemirror\//u],
	});
	assert.equal(config.input, "src/main.ts");
	assert.equal(config.platform, "node");
	assert.equal(config.output.file, "main.js");
	assert.equal(config.output.format, "cjs");
	assert.ok(config.external.includes("obsidian"));
	assert.ok(config.external.includes("electron"));
	assert.ok(
		config.external.some((value) => value instanceof RegExp && value.test("@codemirror/view")),
	);
});

test("requires an input entry point", () => {
	assert.throws(() => createObsidianPluginConfig({}), /requires an input/u);
});
