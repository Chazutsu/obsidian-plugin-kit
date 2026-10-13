import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	acquireVaultDeployLockScope,
	collectArtifactSet,
	deployArtifactSet,
	deployPluginTargets,
	enableCommunityPlugin,
	OBSIDIAN_RELEASE_FILES,
	prepareObsidianVaults,
	validatePluginTarget,
	validateObsidianManifest,
} from "../src/deploy.mjs";
import { deployProducts } from "./fixtures/deploy-products.mjs";

test("validates the manifest and versions deployment contract", () => {
	const manifest = {
		id: "example",
		version: "1.2.0",
		minAppVersion: "1.8.0",
		isDesktopOnly: false,
	};
	assert.equal(
		validateObsidianManifest({ manifest, versions: { "1.2.0": "1.8.0" }, expectedId: "example" }),
		manifest,
	);
	assert.throws(
		() =>
			validateObsidianManifest({ manifest, versions: { "1.2.0": "1.8.0" }, expectedId: "other" }),
		/invalid id/u,
	);
	assert.throws(
		() =>
			validateObsidianManifest({ manifest, versions: { "1.2.0": "1.7.0" }, expectedId: "example" }),
		/minimum Obsidian version/u,
	);
	assert.throws(
		() =>
			validateObsidianManifest({
				manifest: { ...manifest, isDesktopOnly: true },
				versions: { "1.2.0": "1.8.0" },
				expectedId: "example",
			}),
		/isDesktopOnly=false/u,
	);
	assert.deepEqual(
		validateObsidianManifest({
			manifest: { ...manifest, isDesktopOnly: true },
			versions: { "1.2.0": "1.8.0" },
			expectedId: "example",
			mobile: false,
		}),
		{ ...manifest, isDesktopOnly: true },
	);
});

test("validates the standard Obsidian release artifacts", async () => {
	const source = await fs.mkdtemp(path.join(tmpdir(), "obsidian-artifacts-"));
	try {
		for (const name of OBSIDIAN_RELEASE_FILES)
			await fs.writeFile(path.join(source, name), `content:${name}`);
		const result = await collectArtifactSet({ source });
		assert.deepEqual([...result.sourceFiles.keys()], [...OBSIDIAN_RELEASE_FILES]);
		assert.equal(
			result.digests.get("main.js"),
			createHash("sha256").update("content:main.js").digest("hex"),
		);
	} finally {
		await fs.rm(source, { recursive: true, force: true });
	}
});

test("rejects empty artifacts", async () => {
	const source = await fs.mkdtemp(path.join(tmpdir(), "obsidian-artifacts-empty-"));
	try {
		for (const name of OBSIDIAN_RELEASE_FILES)
			await fs.writeFile(path.join(source, name), name === "styles.css" ? "" : name);
		await assert.rejects(collectArtifactSet({ source }), /styles\.css is missing or empty/u);
	} finally {
		await fs.rm(source, { recursive: true, force: true });
	}
});

test("enables a community plugin without duplicates", () => {
	assert.deepEqual(JSON.parse(enableCommunityPlugin('["dataview"]', "example").content), [
		"dataview",
		"example",
	]);
	assert.equal(enableCommunityPlugin('["example"]', "example").changed, false);
	assert.throws(
		() => enableCommunityPlugin('{"enabled":true}', "example"),
		/array of plugin ID strings/u,
	);
});

test("restricts deployment targets to plugins/pluginId", () => {
	assert.equal(
		validatePluginTarget("/vault/.obsidian/plugins/example", "example"),
		"/vault/.obsidian/plugins/example",
	);
	assert.throws(
		() => validatePluginTarget("/vault/.obsidian/plugins/other", "example"),
		/plugins\/example/u,
	);
	assert.throws(
		() => validatePluginTarget("/vault/.obsidian/example", "example"),
		/plugins\/example/u,
	);
});

test("fails closed when an inferred Vault or .obsidian directory does not exist", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-vault-validation-"));
	try {
		await assert.rejects(
			prepareObsidianVaults({ vaults: [path.join(root, "missing")] }),
			/Obsidian Vault root does not exist/u,
		);
		const vault = path.join(root, "vault");
		await fs.mkdir(vault);
		await assert.rejects(
			prepareObsidianVaults({ vaults: [vault] }),
			/Obsidian config directory does not exist/u,
		);
		assert.equal(await fs.stat(path.join(vault, ".obsidian")).catch(() => null), null);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("rejects files as Vault roots or .obsidian directories", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-vault-files-"));
	try {
		const file = path.join(root, "vault-file");
		await fs.writeFile(file, "not a vault");
		await assert.rejects(
			prepareObsidianVaults({ vaults: [file] }),
			/Obsidian Vault root must be a directory/u,
		);
		const vault = path.join(root, "vault");
		await fs.mkdir(vault);
		await fs.writeFile(path.join(vault, ".obsidian"), "not a directory");
		await assert.rejects(
			prepareObsidianVaults({ vaults: [vault] }),
			/Obsidian config directory must be a directory/u,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("canonicalizes a symlink Vault alias without creating a second target", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-vault-alias-"));
	try {
		const vault = path.join(root, "vault");
		const alias = path.join(root, "alias");
		await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
		await fs.symlink(vault, alias, "dir");
		const [real, linked] = await prepareObsidianVaults({ vaults: [vault, alias] });
		assert.equal(real.canonicalVault, linked.canonicalVault);
		assert.equal(real.canonicalConfigDir, linked.canonicalConfigDir);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("deduplicates symlink targets before a plugins directory exists", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-vault-new-alias-"));
	try {
		const vault = path.join(root, "vault");
		const alias = path.join(root, "alias");
		await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
		await fs.symlink(vault, alias, "dir");
		const deployed = [];
		await deployPluginTargets({
			targets: [vault, alias].map((entry) => path.join(entry, ".obsidian", "plugins", "example")),
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy: async ({ target }) => {
				deployed.push(target);
				return { rollback: async () => undefined };
			},
		});
		assert.deepEqual(deployed, [path.join(vault, ".obsidian", "plugins", "example")]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("initializes only an explicitly opted-in target", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-vault-init-"));
	try {
		const vault = path.join(root, "new-vault");
		await prepareObsidianVaults({ vaults: [vault], initTarget: true });
		assert.equal((await fs.stat(path.join(vault, ".obsidian"))).isDirectory(), true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("restores previous artifacts when deployment fails", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const artifacts = await collectArtifactSet({ source });
		let failed = false;
		const failingFs = {
			...fs,
			rename: async (from, to) => {
				if (!failed && to === path.join(target, "styles.css") && from.endsWith(".stage")) {
					failed = true;
					throw new Error("simulated rename failure");
				}
				return fs.rename(from, to);
			},
		};
		await assert.rejects(
			deployArtifactSet({ target, ...artifacts, fs: failingFs }),
			/simulated rename failure/u,
		);
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `old:${name}`);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("partial deployment rollback preserves a later artifact update and reports the conflict", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-partial-cas-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const artifacts = await collectArtifactSet({ source });
		let failed = false;
		const interleavingFs = {
			...fs,
			rename: async (from, to) => {
				if (!failed && to === path.join(target, "styles.css") && from.endsWith(".stage")) {
					failed = true;
					await fs.writeFile(path.join(target, "main.js"), "later:main.js");
					throw new Error("simulated rename failure");
				}
				return fs.rename(from, to);
			},
		};

		await assert.rejects(
			deployArtifactSet({ target, ...artifacts, fs: interleavingFs }),
			(error) => {
				assert.match(error.message, /simulated rename failure/u);
				assert.match(error.message, /Rollback incomplete/u);
				assert.match(error.message, /main\.js: rollback conflict/u);
				return true;
			},
		);

		assert.equal(await fs.readFile(path.join(target, "main.js"), "utf8"), "later:main.js");
		assert.equal(await fs.readFile(path.join(target, "styles.css"), "utf8"), "old:styles.css");
		assert.equal(
			await fs.readFile(path.join(target, "manifest.json"), "utf8"),
			"old:manifest.json",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("can roll back an earlier successful deployment", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-rollback-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const artifacts = await collectArtifactSet({ source });
		const deployment = await deployArtifactSet({ target, ...artifacts });
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `new:${name}`);
		await deployment.rollback();
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `old:${name}`);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("never reads evicted destination artifacts before replacing them", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-evicted-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		const activated = new Set();
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const evictedFs = {
			...fs,
			readFile: async (file, ...args) => {
				if (
					OBSIDIAN_RELEASE_FILES.some(
						(name) => file === path.join(target, name) && !activated.has(name),
					)
				)
					throw new Error(`evicted destination read: ${file}`);
				return fs.readFile(file, ...args);
			},
			rename: async (from, to) => {
				const name = OBSIDIAN_RELEASE_FILES.find(
					(candidate) => to === path.join(target, candidate) && from.endsWith(".stage"),
				);
				if (name) activated.add(name);
				return fs.rename(from, to);
			},
		};
		const deployment = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source })),
			fs: evictedFs,
		});
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `new:${name}`);

		await deployment.rollback();
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `old:${name}`);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("finalize removes renamed artifact backups and disables rollback", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-finalize-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const deployment = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source })),
		});
		assert.equal((await fs.readdir(target)).filter((name) => name.endsWith(".backup")).length, 3);

		await deployment.finalize();

		assert.equal((await fs.readdir(target)).filter((name) => name.endsWith(".backup")).length, 0);
		assert.equal(await deployment.rollback(), false);
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `new:${name}`);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("does not roll back any artifact after one deployed file changes", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-cas-change-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const deployment = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source })),
		});
		await fs.writeFile(path.join(target, "styles.css"), "external:styles.css");

		await deployment.rollback();

		assert.equal(await fs.readFile(path.join(target, "main.js"), "utf8"), "new:main.js");
		assert.equal(await fs.readFile(path.join(target, "styles.css"), "utf8"), "external:styles.css");
		assert.equal(
			await fs.readFile(path.join(target, "manifest.json"), "utf8"),
			"new:manifest.json",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("does not roll back remaining artifacts when a deployed file is missing", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-cas-missing-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(target, name), `old:${name}`);
		}
		const deployment = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source })),
		});
		await fs.rm(path.join(target, "styles.css"));

		await deployment.rollback();

		assert.equal(await fs.readFile(path.join(target, "main.js"), "utf8"), "new:main.js");
		await assert.rejects(fs.stat(path.join(target, "styles.css")), { code: "ENOENT" });
		assert.equal(
			await fs.readFile(path.join(target, "manifest.json"), "utf8"),
			"new:manifest.json",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("an older rollback cannot overwrite a later deployment", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-cas-generation-"));
	const firstSource = path.join(root, "first");
	const secondSource = path.join(root, "second");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(firstSource);
		await fs.mkdir(secondSource);
		await fs.mkdir(target);
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(target, name), `old:${name}`);
			await fs.writeFile(path.join(firstSource, name), `first:${name}`);
			await fs.writeFile(path.join(secondSource, name), `second:${name}`);
		}
		const first = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source: firstSource })),
		});
		const second = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source: secondSource })),
		});

		await first.rollback();
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `second:${name}`);

		await second.rollback();
		for (const name of OBSIDIAN_RELEASE_FILES)
			assert.equal(await fs.readFile(path.join(target, name), "utf8"), `first:${name}`);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("rolls back a first deployment by removing its created artifacts", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-cas-create-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	try {
		await fs.mkdir(source);
		for (const name of OBSIDIAN_RELEASE_FILES)
			await fs.writeFile(path.join(source, name), `new:${name}`);
		const deployment = await deployArtifactSet({
			target,
			...(await collectArtifactSet({ source })),
		});

		await deployment.rollback();

		for (const name of OBSIDIAN_RELEASE_FILES)
			await assert.rejects(fs.stat(path.join(target, name)), { code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("deploys and enables multiple vaults transactionally", async () => {
	const targets = [
		"/vault/local/.obsidian/plugins/example",
		"/vault/icloud/.obsidian/plugins/example",
	];
	const localConfig = "/vault/local/.obsidian/community-plugins.json";
	const icloudConfig = "/vault/icloud/.obsidian/community-plugins.json";
	const files = new Map([
		[localConfig, '["dataview"]'],
		[icloudConfig, '["dataview"]'],
	]);
	const rolledBack = [];
	const deployed = [];
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};
	const deploy = async ({ target }) => {
		deployed.push(target);
		if (target === targets[1]) throw new Error("iCloud unavailable");
		return { rollback: async () => rolledBack.push(target) };
	};

	await assert.rejects(
		deployPluginTargets({
			targets,
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy,
			fs: fakeFs,
		}),
		/iCloud unavailable/u,
	);
	assert.deepEqual(deployed, targets);
	assert.deepEqual(rolledBack, [targets[0]]);
	assert.deepEqual(JSON.parse(files.get(localConfig)), ["dataview"]);
	assert.equal(files.get(icloudConfig), '["dataview"]');
});

test("deploys once when a symlink and real path resolve to the same vault", async () => {
	const targets = [
		"/repo/vault/.obsidian/plugins/example",
		"/icloud/vault/.obsidian/plugins/example",
	];
	const configPath = "/repo/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	const deployed = [];
	const fakeFs = {
		realpath: async () => "/icloud/vault/.obsidian/plugins/example",
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};
	await deployPluginTargets({
		targets,
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async ({ target }) => {
			deployed.push(target);
			return { rollback: async () => undefined };
		},
	});
	assert.deepEqual(deployed, [targets[0]]);
	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "example"]);
});

test("does not treat temporary cleanup failure after activation commit as deployment failure", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	let artifactRollbacks = 0;
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => {
			if (file.includes("community-plugins.json.") && file.endsWith(".tmp"))
				throw new Error("simulated cleanup failure");
			files.delete(file);
		},
	};

	await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => ({
			rollback: async () => {
				artifactRollbacks += 1;
			},
		}),
	});

	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "example"]);
	assert.equal(artifactRollbacks, 0);
});

test("returns a rollback handle that restores artifacts and activation", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	let artifactRollbacks = 0;
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};
	const deployment = await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => ({
			rollback: async () => {
				artifactRollbacks += 1;
			},
		}),
	});
	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "example"]);

	await deployment.rollback();
	await deployment.rollback();
	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing"]);
	assert.equal(artifactRollbacks, 1);
});

test("keeps activation when public artifact rollback detects a conflict", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};
	const deployment = await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => ({ rollback: async () => false }),
	});

	await assert.rejects(deployment.rollback(), /Rollback incomplete.*rollback conflict/u);

	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "example"]);
});

test("merges activation with config changes made during artifact deployment", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};

	await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => {
			files.set(configPath, '["existing","external"]');
			return { rollback: async () => undefined };
		},
	});

	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "external", "example"]);
});

test("rollback removes only its activation and preserves later config changes", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["existing"]']]);
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		rm: async (file) => files.delete(file),
	};
	const deployment = await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => ({ rollback: async () => undefined }),
	});
	files.set(configPath, '["existing","example","external"]');

	await deployment.rollback();

	assert.deepEqual(JSON.parse(files.get(configPath)), ["existing", "external"]);
});

test("rollback keeps a plugin id that was enabled before deployment", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const files = new Map([[configPath, '["example"]']]);
	const fakeFs = {
		readFile: async (file) => files.get(file),
	};
	const deployment = await deployPluginTargets({
		targets: [target],
		sourceFiles: new Map(),
		digests: new Map(),
		pluginId: "example",
		fs: fakeFs,
		deploy: async () => ({ rollback: async () => undefined }),
	});

	await deployment.rollback();

	assert.deepEqual(JSON.parse(files.get(configPath)), ["example"]);
});

test("vault deployment locks reject active owners and recover dead local owners", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-lock-"));
	const configDir = path.join(root, ".obsidian");
	const target = path.join(configDir, "plugins", "example");
	const lockPath = path.join(configDir, ".obsidian-plugin-deploy.lock");
	try {
		await fs.mkdir(configDir, { recursive: true });
		let signalStarted;
		const started = new Promise((resolve) => {
			signalStarted = resolve;
		});
		let signalFinish;
		const finish = new Promise((resolve) => {
			signalFinish = resolve;
		});
		const first = deployPluginTargets({
			targets: [target],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy: async () => {
				signalStarted();
				await finish;
				return { rollback: async () => undefined };
			},
		});
		await started;
		await assert.rejects(
			deployPluginTargets({
				targets: [target],
				sourceFiles: new Map(),
				digests: new Map(),
				pluginId: "example",
				deploy: async () => ({ rollback: async () => undefined }),
			}),
			/already held/u,
		);
		signalFinish();
		await first;
		await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });

		await fs.mkdir(lockPath);
		await fs.writeFile(
			path.join(lockPath, "owner.json"),
			JSON.stringify({ token: "dead", hostname: hostname(), pid: 99_999_999 }),
		);
		await deployPluginTargets({
			targets: [target],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy: async () => ({ rollback: async () => undefined }),
		});
		await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("vault lock scope canonicalizes symlink aliases and locks the vault once", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-scope-alias-"));
	const realVault = path.join(root, "real-vault");
	const aliasVault = path.join(root, "alias-vault");
	const realConfigDir = path.join(realVault, ".obsidian");
	const aliasConfigDir = path.join(aliasVault, ".obsidian");
	try {
		await fs.mkdir(realConfigDir, { recursive: true });
		await fs.symlink(realVault, aliasVault, "dir");
		const lockPath = path.join(await fs.realpath(realConfigDir), ".obsidian-plugin-deploy.lock");
		let lockCreates = 0;
		let lockReleases = 0;
		const countingFs = {
			...fs,
			mkdir: async (target, ...args) => {
				if (target === lockPath) lockCreates += 1;
				return fs.mkdir(target, ...args);
			},
			rm: async (target, ...args) => {
				if (target === lockPath) lockReleases += 1;
				return fs.rm(target, ...args);
			},
		};

		const scope = await acquireVaultDeployLockScope({
			configDirs: [realConfigDir, aliasConfigDir],
			fs: countingFs,
		});

		assert.equal(scope.owns(realConfigDir), true);
		assert.equal(scope.owns(aliasConfigDir), true);
		assert.equal(lockCreates, 1);
		await scope.release();
		assert.equal(lockReleases, 1);
		await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("does not steal a deployment lock owned by another host", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-lock-host-"));
	const configDir = path.join(root, ".obsidian");
	const target = path.join(configDir, "plugins", "example");
	const lockPath = path.join(configDir, ".obsidian-plugin-deploy.lock");
	try {
		await fs.mkdir(lockPath, { recursive: true });
		await fs.writeFile(
			path.join(lockPath, "owner.json"),
			JSON.stringify({ token: "remote", hostname: "other-host", pid: 123 }),
		);
		await assert.rejects(
			deployPluginTargets({
				targets: [target],
				sourceFiles: new Map(),
				digests: new Map(),
				pluginId: "example",
				deploy: async () => ({ rollback: async () => undefined }),
			}),
			/already held/u,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("stale recovery guard prevents a new live lock from being renamed", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-lock-race-"));
	const configDir = path.join(root, ".obsidian");
	const target = path.join(configDir, "plugins", "example");
	const lockPath = path.join(configDir, ".obsidian-plugin-deploy.lock");
	const ownerPath = path.join(lockPath, "owner.json");
	try {
		await fs.mkdir(lockPath, { recursive: true });
		await fs.writeFile(
			ownerPath,
			JSON.stringify({ token: "stale", hostname: hostname(), pid: 99_999_999 }),
		);
		let signalOwnerRead;
		const ownerRead = new Promise((resolve) => {
			signalOwnerRead = resolve;
		});
		let signalContinue;
		const continueRead = new Promise((resolve) => {
			signalContinue = resolve;
		});
		let paused = false;
		const interleavingFs = {
			...fs,
			readFile: async (file, ...args) => {
				if (file === ownerPath && !paused) {
					paused = true;
					signalOwnerRead();
					await continueRead;
				}
				return fs.readFile(file, ...args);
			},
		};
		const recovering = deployPluginTargets({
			targets: [target],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			fs: interleavingFs,
			deploy: async () => ({ rollback: async () => undefined }),
		});
		await ownerRead;

		await assert.rejects(
			deployPluginTargets({
				targets: [target],
				sourceFiles: new Map(),
				digests: new Map(),
				pluginId: "example",
				fs: interleavingFs,
				deploy: async () => ({ rollback: async () => undefined }),
			}),
			/lifecycle is already claimed/u,
		);
		signalContinue();
		await recovering;
		await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("ignores and cleans a lifecycle claim left by a dead local process", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-guard-stale-"));
	const configDir = path.join(root, ".obsidian");
	const target = path.join(configDir, "plugins", "example");
	const claimsPath = path.join(configDir, ".obsidian-plugin-deploy.lock.guard.claims");
	const crashedClaim = path.join(claimsPath, "crashed.json");
	try {
		await fs.mkdir(claimsPath, { recursive: true });
		await fs.writeFile(
			crashedClaim,
			JSON.stringify({ token: "dead-guard", hostname: hostname(), pid: 99_999_999 }),
		);

		await deployPluginTargets({
			targets: [target],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy: async () => ({ rollback: async () => undefined }),
		});

		await assert.rejects(fs.stat(crashedClaim), { code: "ENOENT" });
		assert.deepEqual(await fs.readdir(claimsPath), []);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("keeps remote and unreadable lifecycle claims as active blockers", async () => {
	for (const [name, content] of [
		["remote.json", JSON.stringify({ token: "remote", hostname: "other-host", pid: 123 })],
		["invalid.json", "not-json"],
	]) {
		const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-guard-blocker-"));
		const configDir = path.join(root, ".obsidian");
		const target = path.join(configDir, "plugins", "example");
		const claimsPath = path.join(configDir, ".obsidian-plugin-deploy.lock.guard.claims");
		const blocker = path.join(claimsPath, name);
		try {
			await fs.mkdir(claimsPath, { recursive: true });
			await fs.writeFile(blocker, content);
			await assert.rejects(
				deployPluginTargets({
					targets: [target],
					sourceFiles: new Map(),
					digests: new Map(),
					pluginId: "example",
					deploy: async () => ({ rollback: async () => undefined }),
				}),
				/lifecycle is already claimed/u,
			);
			assert.equal(await fs.readFile(blocker, "utf8"), content);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}
});

for (const contenderCount of [2, 3]) {
	test(`${contenderCount} simultaneous lifecycle claims fail without overlapping critical sections`, async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-guard-race-"));
		const configDir = path.join(root, ".obsidian");
		const target = path.join(configDir, "plugins", "example");
		const claimsPath = path.join(configDir, ".obsidian-plugin-deploy.lock.guard.claims");
		try {
			await fs.mkdir(configDir, { recursive: true });
			let readdirCount = 0;
			let releaseListings;
			const listingsReady = new Promise((resolve) => {
				releaseListings = resolve;
			});
			const simultaneousFs = {
				...fs,
				readdir: async (directory, ...args) => {
					if (directory === claimsPath) {
						readdirCount += 1;
						if (readdirCount === contenderCount) releaseListings();
						await listingsReady;
					}
					return fs.readdir(directory, ...args);
				},
			};
			let criticalSections = 0;
			const results = await Promise.allSettled(
				Array.from({ length: contenderCount }, () =>
					deployPluginTargets({
						targets: [target],
						sourceFiles: new Map(),
						digests: new Map(),
						pluginId: "example",
						fs: simultaneousFs,
						deploy: async () => {
							criticalSections += 1;
							return { rollback: async () => undefined };
						},
					}),
				),
			);

			assert.equal(
				results.every((result) => result.status === "rejected"),
				true,
			);
			assert.equal(criticalSections, 0);
			assert.deepEqual(await fs.readdir(claimsPath), []);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

test("rolls back earlier products in reverse order when suite deployment fails", async () => {
	const selected = [
		{ directory: "first", id: "first" },
		{ directory: "second", id: "second" },
		{ directory: "third", id: "third" },
	];
	const manifests = new Map(
		selected.flatMap(({ directory, id }) => [
			[
				`/repo/apps/${directory}/manifest.json`,
				JSON.stringify({ id, version: "1.0.0", minAppVersion: "1.8.0", isDesktopOnly: false }),
			],
			[`/repo/apps/${directory}/versions.json`, JSON.stringify({ "1.0.0": "1.8.0" })],
		]),
	);
	const events = [];
	let lockActive = false;

	await assert.rejects(
		deployProducts({
			selected,
			repository: "/repo",
			vaults: ["/desktop", "/icloud"],
			read: async (file) => manifests.get(file),
			collect: async () => ({ sourceFiles: new Map(), digests: new Map() }),
			prepareVaults: async () => {},
			acquireLocks: async () => {
				events.push("lock:acquire");
				lockActive = true;
				return {
					owns: () => lockActive,
					release: async () => {
						events.push("lock:release");
						lockActive = false;
					},
				};
			},
			deployTargets: async ({ pluginId, lockScope }) => {
				assert.equal(lockScope.owns("/desktop/.obsidian"), true);
				events.push(`deploy:${pluginId}`);
				if (pluginId === "third") throw new Error("third failed");
				return {
					rollback: async () => {
						assert.equal(lockActive, true);
						events.push(`rollback:${pluginId}`);
					},
				};
			},
			log: () => {},
		}),
		/third failed/u,
	);
	assert.deepEqual(events, [
		"lock:acquire",
		"deploy:first",
		"deploy:second",
		"deploy:third",
		"rollback:second",
		"rollback:first",
		"lock:release",
	]);
});

test("finalizes every product only after the complete suite succeeds", async () => {
	const selected = [
		{ directory: "first", id: "first" },
		{ directory: "second", id: "second" },
	];
	const manifests = new Map(
		selected.flatMap(({ directory, id }) => [
			[
				`/repo/apps/${directory}/manifest.json`,
				JSON.stringify({ id, version: "1.0.0", minAppVersion: "1.8.0", isDesktopOnly: false }),
			],
			[`/repo/apps/${directory}/versions.json`, JSON.stringify({ "1.0.0": "1.8.0" })],
		]),
	);
	const events = [];
	await deployProducts({
		selected,
		repository: "/repo",
		vaults: ["/desktop"],
		read: async (file) => manifests.get(file),
		collect: async () => ({ sourceFiles: new Map(), digests: new Map() }),
		prepareVaults: async () => {},
		acquireLocks: async () => ({
			owns: () => true,
			release: async () => events.push("lock:release"),
		}),
		deployTargets: async ({ pluginId }) => {
			events.push(`deploy:${pluginId}`);
			return {
				rollback: async () => events.push(`rollback:${pluginId}`),
				finalize: async () => events.push(`finalize:${pluginId}`),
			};
		},
		log: () => {},
	});
	assert.deepEqual(events, [
		"deploy:first",
		"deploy:second",
		"finalize:first",
		"finalize:second",
		"lock:release",
	]);
});

test("a finalize cleanup failure never starts an irreversible suite rollback", async () => {
	const selected = [{ directory: "first", id: "first" }];
	const manifests = new Map([
		[
			"/repo/apps/first/manifest.json",
			JSON.stringify({
				id: "first",
				version: "1.0.0",
				minAppVersion: "1.8.0",
				isDesktopOnly: false,
			}),
		],
		["/repo/apps/first/versions.json", JSON.stringify({ "1.0.0": "1.8.0" })],
	]);
	let rollbacks = 0;
	let releases = 0;
	await assert.rejects(
		deployProducts({
			selected,
			repository: "/repo",
			vaults: ["/desktop"],
			read: async (file) => manifests.get(file),
			collect: async () => ({ sourceFiles: new Map(), digests: new Map() }),
			prepareVaults: async () => {},
			acquireLocks: async () => ({
				owns: () => true,
				release: async () => {
					releases += 1;
				},
			}),
			deployTargets: async () => ({
				rollback: async () => {
					rollbacks += 1;
				},
				finalize: async () => {
					throw new Error("backup cleanup unavailable");
				},
			}),
			log: () => {},
		}),
		/Suite finalize failed.*backup cleanup unavailable/u,
	);
	assert.equal(rollbacks, 0);
	assert.equal(releases, 1);
});

test("requires targets and pluginId for multi-vault deployment", async () => {
	await assert.rejects(
		deployPluginTargets({
			targets: [],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
		}),
		/At least one deployment target/u,
	);
	await assert.rejects(
		deployPluginTargets({
			targets: ["/vault/.obsidian/plugins/example"],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "",
		}),
		/pluginId/u,
	);
	await assert.rejects(
		deployPluginTargets({
			targets: ["/vault/.obsidian/plugins/other"],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
		}),
		/plugins\/example/u,
	);
});

test("removes temporary files and uses CAS rollback when activation fails", async () => {
	const target = "/vault/.obsidian/plugins/example";
	const configPath = "/vault/.obsidian/community-plugins.json";
	const temporaryConfig = `${configPath}.${process.pid}.tmp`;
	const files = new Map([[configPath, '["dataview"]']]);
	let rolledBack = false;
	const fakeFs = {
		readFile: async (file) => {
			if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return files.get(file);
		},
		writeFile: async (file, content) => files.set(file, content),
		rename: async () => {
			throw new Error("rename unavailable");
		},
		rm: async (file) => files.delete(file),
	};

	await assert.rejects(
		deployPluginTargets({
			targets: [target],
			sourceFiles: new Map(),
			digests: new Map(),
			pluginId: "example",
			deploy: async () => ({
				rollback: async () => {
					rolledBack = true;
				},
			}),
			fs: fakeFs,
		}),
		/rename unavailable/u,
	);
	assert.equal(rolledBack, true);
	assert.equal(files.has(temporaryConfig), false);
	assert.equal(files.get(configPath), '["dataview"]');
});

test("automatic rollback preserves a later artifact update and reports the conflict", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "obsidian-deploy-transaction-cas-"));
	const source = path.join(root, "source");
	const firstTarget = path.join(root, "first", ".obsidian", "plugins", "example");
	const secondTarget = path.join(root, "second", ".obsidian", "plugins", "example");
	const firstConfig = path.resolve(firstTarget, "..", "..", "community-plugins.json");
	const secondConfig = path.resolve(secondTarget, "..", "..", "community-plugins.json");
	try {
		await fs.mkdir(source);
		await fs.mkdir(firstTarget, { recursive: true });
		await fs.mkdir(secondTarget, { recursive: true });
		for (const name of OBSIDIAN_RELEASE_FILES) {
			await fs.writeFile(path.join(source, name), `new:${name}`);
			await fs.writeFile(path.join(firstTarget, name), `old:${name}`);
		}
		await fs.writeFile(firstConfig, '["existing"]');
		await fs.writeFile(secondConfig, '["existing"]');
		const artifacts = await collectArtifactSet({ source });

		await assert.rejects(
			deployPluginTargets({
				targets: [firstTarget, secondTarget],
				...artifacts,
				pluginId: "example",
				deploy: async (options) => {
					if (options.target === secondTarget) {
						await fs.writeFile(path.join(firstTarget, "styles.css"), "later:styles.css");
						throw new Error("second target failed");
					}
					return deployArtifactSet(options);
				},
			}),
			(error) => {
				assert.match(error.message, /second target failed/u);
				assert.match(error.message, /Rollback incomplete/u);
				assert.match(error.message, /rollback conflict/u);
				return true;
			},
		);

		assert.equal(await fs.readFile(path.join(firstTarget, "main.js"), "utf8"), "new:main.js");
		assert.equal(
			await fs.readFile(path.join(firstTarget, "styles.css"), "utf8"),
			"later:styles.css",
		);
		assert.equal(
			await fs.readFile(path.join(firstTarget, "manifest.json"), "utf8"),
			"new:manifest.json",
		);
		assert.deepEqual(JSON.parse(await fs.readFile(firstConfig, "utf8")), ["existing", "example"]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
