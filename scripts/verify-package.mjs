import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.match(
	packageManifest.version,
	/^0\.1\.(0|[1-9]\d*)$/u,
	"The package version must remain in the 0.1.x patch-only release series",
);
const destination = mkdtempSync(path.join(tmpdir(), "obsidian-plugin-kit-pack-"));
const expectedFiles = [
	"CHANGELOG.md",
	"LICENSE",
	"README.ja.md",
	"README.md",
	"package.json",
	"src/deploy.d.ts",
	"src/deploy.mjs",
	"src/rolldown.d.ts",
	"src/rolldown.mjs",
	"tsconfig.base.json",
].toSorted();

try {
	const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	const [packed] = JSON.parse(output);
	assert.equal(packed.name, packageManifest.name);
	assert.equal(packed.version, packageManifest.version);
	assert.deepEqual(
		packed.files.map(({ path: file }) => file).toSorted(),
		expectedFiles,
		"The package tarball contains an unexpected or missing file",
	);
} finally {
	rmSync(destination, { recursive: true, force: true });
}
