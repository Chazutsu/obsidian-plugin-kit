import { createHash, randomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import path from "node:path";

export const OBSIDIAN_RELEASE_FILES = Object.freeze(["main.js", "styles.css", "manifest.json"]);

export function validateObsidianManifest({ manifest, versions, expectedId, mobile = true }) {
	if (!manifest || typeof manifest !== "object")
		throw new TypeError("manifest.json must contain an object");
	if (manifest.id !== expectedId)
		throw new Error(`manifest.json has an invalid id: ${manifest.id ?? "missing"}`);
	if (typeof manifest.version !== "string" || !manifest.version)
		throw new Error("manifest.json has an invalid version");
	if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion)
		throw new Error("manifest.json has an invalid minAppVersion");
	if (mobile && manifest.isDesktopOnly !== false)
		throw new Error("Mobile-compatible plugins must set isDesktopOnly=false");
	if (!versions || versions[manifest.version] !== manifest.minAppVersion) {
		throw new Error(
			"versions.json and manifest.json must declare the same minimum Obsidian version",
		);
	}
	return manifest;
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

async function writeFileAtomically(fs, target, content) {
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	let committed = false;
	let failure;
	try {
		await fs.writeFile(temporary, content, "utf8");
		await fs.rename(temporary, target);
		committed = true;
	} catch (error) {
		failure = error;
	}
	try {
		await fs.rm(temporary, { force: true });
	} catch (error) {
		// Once rename commits, cleanup failure must not make callers roll back
		// artifacts while leaving the activation file on its new contents.
		if (!committed && !failure) failure = error;
	}
	if (failure) throw failure;
}

export function enableCommunityPlugin(source, pluginId) {
	const plugins = parseCommunityPlugins(source);
	if (plugins.includes(pluginId))
		return { changed: false, content: `${JSON.stringify(plugins, null, 2)}\n` };
	return { changed: true, content: `${JSON.stringify([...plugins, pluginId], null, 2)}\n` };
}

function parseCommunityPlugins(source) {
	const plugins = source.trim() ? JSON.parse(source) : [];
	if (!Array.isArray(plugins) || plugins.some((value) => typeof value !== "string"))
		throw new Error("community-plugins.json must be an array of plugin ID strings");
	return plugins;
}

async function readOptionalText(fs, file, fallback = "[]") {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return fallback;
		throw error;
	}
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

async function acquireLockLifecycleGuard({
	configDir,
	fs,
	hostname = getHostname(),
	isProcessAlive = processIsAlive,
}) {
	const claimsPath = path.join(configDir, ".obsidian-plugin-deploy.lock.guard.claims");
	const token = randomUUID();
	const owner = { token, hostname, pid: process.pid, createdAt: new Date().toISOString() };
	const claimPath = path.join(claimsPath, `${Date.now()}-${token}.json`);
	await fs.mkdir(claimsPath, { recursive: true });
	let claimHandle;
	try {
		claimHandle = await fs.open(claimPath, "wx");
		await claimHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
	} catch (error) {
		await fs.rm(claimPath, { force: true });
		throw error;
	} finally {
		await claimHandle?.close();
	}

	try {
		const competingClaims = [];
		for (const name of await fs.readdir(claimsPath)) {
			const currentPath = path.join(claimsPath, name);
			if (currentPath === claimPath) continue;
			let currentOwner;
			try {
				currentOwner = JSON.parse(await fs.readFile(currentPath, "utf8"));
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				competingClaims.push(name);
				continue;
			}
			const deadLocalClaim =
				currentOwner?.hostname === hostname &&
				Number.isSafeInteger(currentOwner?.pid) &&
				!isProcessAlive(currentOwner.pid);
			if (deadLocalClaim) await fs.rm(currentPath, { force: true });
			else competingClaims.push(name);
		}
		if (competingClaims.length)
			throw new Error(
				`Deployment lock lifecycle is already claimed: ${competingClaims.join(", ")}`,
			);
	} catch (error) {
		await fs.rm(claimPath, { force: true });
		throw error;
	}
	return () => fs.rm(claimPath, { force: true });
}

async function acquireVaultDeployLock({
	configDir,
	fs = defaultFs,
	hostname = getHostname(),
	isProcessAlive = processIsAlive,
}) {
	if (typeof fs.mkdir !== "function") return async () => {};
	const lockPath = path.join(configDir, ".obsidian-plugin-deploy.lock");
	const ownerPath = path.join(lockPath, "owner.json");
	const token = randomUUID();
	const owner = { token, hostname, pid: process.pid, createdAt: new Date().toISOString() };

	const create = async () => {
		await fs.mkdir(lockPath);
		try {
			await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
		} catch (error) {
			await fs.rm(lockPath, { recursive: true, force: true });
			throw error;
		}
	};

	const releaseGuard = await acquireLockLifecycleGuard({ configDir, fs, hostname, isProcessAlive });
	try {
		try {
			await create();
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let existingOwner;
			try {
				existingOwner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
			} catch (ownerError) {
				throw new Error(`Deployment lock is already held: ${lockPath}`, { cause: ownerError });
			}
			const stale =
				existingOwner?.hostname === hostname &&
				Number.isSafeInteger(existingOwner?.pid) &&
				!isProcessAlive(existingOwner.pid);
			if (!stale) throw new Error(`Deployment lock is already held: ${lockPath}`, { cause: error });

			const stalePath = `${lockPath}.stale.${token}`;
			await fs.rename(lockPath, stalePath);
			const claimedOwner = JSON.parse(
				await fs.readFile(path.join(stalePath, "owner.json"), "utf8"),
			);
			if (claimedOwner?.token !== existingOwner.token) {
				await fs.rename(stalePath, lockPath);
				throw new Error(`Deployment lock ownership changed: ${lockPath}`, { cause: error });
			}
			await fs.rm(stalePath, { recursive: true, force: true });
			await create();
		}
	} finally {
		await releaseGuard();
	}

	let released = false;
	return async () => {
		if (released) return;
		const releaseLifecycleGuard = await acquireLockLifecycleGuard({
			configDir,
			fs,
			hostname,
			isProcessAlive,
		});
		try {
			let currentOwner;
			try {
				currentOwner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
			} catch (error) {
				if (error?.code === "ENOENT") {
					released = true;
					return;
				}
				throw error;
			}
			if (currentOwner?.token !== token)
				throw new Error(`Deployment lock ownership changed: ${lockPath}`);
			await fs.rm(lockPath, { recursive: true, force: true });
			released = true;
		} finally {
			await releaseLifecycleGuard();
		}
	};
}

export async function acquireVaultDeployLockScope({ configDirs, fs = defaultFs }) {
	const ownedConfigDirs = new Set();
	const canonicalConfigDirs = new Set();
	for (const configDir of configDirs) {
		const normalized = path.resolve(configDir);
		let canonical = normalized;
		if (typeof fs.realpath === "function") {
			try {
				canonical = await fs.realpath(normalized);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				try {
					canonical = path.join(
						await fs.realpath(path.dirname(normalized)),
						path.basename(normalized),
					);
				} catch (parentError) {
					if (parentError?.code !== "ENOENT") throw parentError;
				}
			}
		}
		ownedConfigDirs.add(normalized);
		ownedConfigDirs.add(canonical);
		canonicalConfigDirs.add(canonical);
	}
	const normalizedConfigDirs = [...canonicalConfigDirs].toSorted();
	const releases = [];
	const releaseAll = async () => {
		const errors = [];
		for (const release of releases.toReversed()) {
			try {
				await release();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	};
	try {
		for (const configDir of normalizedConfigDirs)
			releases.push(await acquireVaultDeployLock({ configDir, fs }));
	} catch (error) {
		const releaseErrors = await releaseAll();
		if (releaseErrors.length && error instanceof Error)
			error.message = `${error.message}\nLock release failed: ${releaseErrors.map(String).join(" / ")}`;
		throw error;
	}
	let active = true;
	return {
		owns(configDir) {
			return active && ownedConfigDirs.has(path.resolve(configDir));
		},
		async release() {
			if (!active) return;
			const errors = await releaseAll();
			if (errors.length) throw new Error(`Lock release failed: ${errors.map(String).join(" / ")}`);
			active = false;
		},
	};
}

export function validatePluginTarget(target, pluginId) {
	if (typeof target !== "string" || !target) throw new TypeError("target is required");
	if (typeof pluginId !== "string" || !pluginId) throw new TypeError("pluginId is required");
	const normalized = path.resolve(target);
	if (
		path.basename(normalized) !== pluginId ||
		path.basename(path.dirname(normalized)) !== "plugins"
	) {
		throw new Error(`Deployment target must end with plugins/${pluginId}: ${target}`);
	}
	return normalized;
}

async function requireDirectory(fs, directory, label) {
	let info;
	try {
		info = await fs.stat(directory);
	} catch (error) {
		if (error?.code === "ENOENT")
			throw new Error(`${label} does not exist: ${directory}`, { cause: error });
		throw error;
	}
	if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
}

/**
 * Validates Vault roots before deployment can acquire a lock or create plugin
 * directories. New Vault configuration directories are created only when the
 * caller explicitly opts into target initialization.
 */
export async function prepareObsidianVaults({ vaults, initTarget = false, fs = defaultFs }) {
	if (!Array.isArray(vaults) || vaults.length === 0)
		throw new TypeError("At least one Obsidian Vault is required");
	const prepared = [];
	for (const vault of vaults) {
		if (typeof vault !== "string" || !vault) throw new TypeError("Vault path is required");
		const root = path.resolve(vault);
		const configDir = path.join(root, ".obsidian");
		if (initTarget) {
			await fs.mkdir(configDir, { recursive: true });
		} else {
			await requireDirectory(fs, root, "Obsidian Vault root");
			await requireDirectory(fs, configDir, "Obsidian config directory");
		}
		// Resolve both paths after validation so aliases are stable and broken
		// symlinks fail before any deployment mutation starts.
		prepared.push({
			vault: root,
			canonicalVault: await fs.realpath(root),
			configDir,
			canonicalConfigDir: await fs.realpath(configDir),
		});
	}
	return prepared;
}

export async function collectArtifactSet({
	source,
	files = OBSIDIAN_RELEASE_FILES,
	fs = defaultFs,
}) {
	const sourceFiles = new Map();
	const digests = new Map();
	for (const file of files) {
		const sourcePath = path.join(source, file);
		const info = await fs.stat(sourcePath);
		if (!info.isFile() || info.size === 0) throw new Error(`${file} is missing or empty`);
		const content = await fs.readFile(sourcePath);
		sourceFiles.set(file, sourcePath);
		digests.set(file, sha256(content));
	}
	return { sourceFiles, digests };
}

export async function deployArtifactSet({ target, sourceFiles, digests, fs = defaultFs }) {
	await fs.mkdir(target, { recursive: true });
	const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
	const staged = new Map();
	const backups = new Map();
	const deployed = [];
	let finalized = false;
	let rolledBack = false;

	const restorePartialDeployment = async () => {
		const rollbackErrors = [];
		for (const [name] of [...sourceFiles].toReversed()) {
			const destination = path.join(target, name);
			const backup = backups.get(name);
			if (!backup) continue;
			if (deployed.includes(name)) {
				let current;
				try {
					current = await fs.readFile(destination);
				} catch (error) {
					rollbackErrors.push(
						`${destination}: ${error?.code === "ENOENT" ? "rollback conflict" : error?.message || error}`,
					);
					continue;
				}
				if (sha256(current) !== digests.get(name)) {
					rollbackErrors.push(`${destination}: rollback conflict`);
					continue;
				}
			} else {
				try {
					await fs.stat(destination);
					rollbackErrors.push(`${destination}: rollback conflict`);
					continue;
				} catch (error) {
					if (error?.code !== "ENOENT") {
						rollbackErrors.push(`${destination}: ${error?.message || error}`);
						continue;
					}
				}
			}
			try {
				if (backup.path) {
					await fs.rename(backup.path, destination);
					backup.path = null;
				} else if (deployed.includes(name)) {
					await fs.rm(destination, { force: true });
				}
			} catch (error) {
				rollbackErrors.push(`${destination}: ${error?.message || error}`);
			}
		}
		return rollbackErrors;
	};
	try {
		for (const [name, source] of sourceFiles) {
			const temporary = path.join(target, `.${name}.${token}.stage`);
			await fs.copyFile(source, temporary);
			const content = await fs.readFile(temporary);
			if (sha256(content) !== digests.get(name))
				throw new Error(`Staging verification failed for ${name}`);
			staged.set(name, temporary);
		}
		for (const [name] of sourceFiles) {
			const destination = path.join(target, name);
			const backup = path.join(target, `.${name}.${token}.backup`);
			try {
				await fs.rename(destination, backup);
				backups.set(name, { path: backup });
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				backups.set(name, { path: null });
			}
			await fs.rename(staged.get(name), destination);
			staged.delete(name);
			deployed.push(name);
		}
		for (const [name] of sourceFiles) {
			const destination = path.join(target, name);
			if (sha256(await fs.readFile(destination)) !== digests.get(name))
				throw new Error(`Hash verification failed for ${destination}`);
		}
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		const rollbackErrors = await restorePartialDeployment();
		if (rollbackErrors.length)
			error.message = `${error.message}\nRollback incomplete: ${rollbackErrors.join(" / ")}`;
		throw error;
	} finally {
		await Promise.all([...staged.values()].map((temporary) => fs.rm(temporary, { force: true })));
	}
	const rollback = async (force) => {
		if (finalized) return false;
		if (rolledBack) return true;
		if (!force) {
			for (const [name] of sourceFiles) {
				const destination = path.join(target, name);
				let content;
				try {
					content = await fs.readFile(destination);
				} catch (error) {
					if (error?.code === "ENOENT") return false;
					throw error;
				}
				if (sha256(content) !== digests.get(name)) return false;
			}
		}
		for (const [name] of [...sourceFiles].toReversed()) {
			const destination = path.join(target, name);
			const backup = backups.get(name);
			if (backup?.path) {
				await fs.rename(backup.path, destination);
				backup.path = null;
			} else {
				await fs.rm(destination, { force: true });
			}
		}
		rolledBack = true;
		return true;
	};
	const finalize = async () => {
		if (rolledBack) return;
		// Crossing this boundary commits the deployment. Cleanup failures are
		// retryable, but must never trigger a rollback after another backup was
		// already deleted.
		finalized = true;
		const cleanupErrors = [];
		for (const [name, backup] of backups) {
			if (!backup.path) continue;
			try {
				await fs.rm(backup.path, { force: true });
				backup.path = null;
			} catch (error) {
				cleanupErrors.push(`${name}: ${error?.message || error}`);
			}
		}
		if (cleanupErrors.length)
			throw new Error(`Artifact backup cleanup failed: ${cleanupErrors.join(" / ")}`);
	};
	return {
		rollback: () => rollback(false),
		forceRollback: () => rollback(true),
		finalize,
	};
}

/**
 * Deploys one plugin to every configured vault as a single transaction and
 * enables it without duplicating entries in community-plugins.json.
 *
 * Target paths must point to `.obsidian/plugins/<plugin-id>`. Product code
 * remains responsible for choosing those targets; this function only owns the
 * Obsidian-specific deployment contract.
 */
export async function deployPluginTargets({
	targets,
	sourceFiles,
	digests,
	pluginId,
	deploy = deployArtifactSet,
	fs = defaultFs,
	log = () => {},
	lockScope,
	initTarget = false,
}) {
	if (!Array.isArray(targets) || targets.length === 0)
		throw new TypeError("At least one deployment target is required");
	if (typeof pluginId !== "string" || !pluginId) throw new TypeError("pluginId is required");
	const validatedTargets = targets.map((target) => validatePluginTarget(target, pluginId));
	let canonicalTargetIdentities;
	if (typeof fs.stat === "function" && typeof fs.realpath === "function") {
		const preparedVaults = await prepareObsidianVaults({
			vaults: validatedTargets.map((target) => path.resolve(target, "..", "..", "..")),
			initTarget,
			fs,
		});
		canonicalTargetIdentities = preparedVaults.map(({ canonicalConfigDir }) =>
			path.join(canonicalConfigDir, "plugins", pluginId),
		);
	}
	const uniqueTargets = [];
	const seenTargets = new Set();
	for (const [index, target] of validatedTargets.entries()) {
		let identity = canonicalTargetIdentities?.[index] ?? target;
		if (typeof fs.realpath === "function") {
			try {
				identity = await fs.realpath(target);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				try {
					identity = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
				} catch (parentError) {
					if (parentError?.code !== "ENOENT") throw parentError;
				}
			}
		}
		if (seenTargets.has(identity)) continue;
		seenTargets.add(identity);
		uniqueTargets.push(target);
	}

	const completed = [];
	let rolledBack = false;
	const rollbackCompleted = async () => {
		if (rolledBack) return;
		const rollbackErrors = [];
		for (const record of completed.toReversed()) {
			let artifactsRolledBack = false;
			try {
				artifactsRolledBack = (await record.rollback()) !== false;
			} catch (error) {
				rollbackErrors.push(`${record.target} artifacts: ${error?.message || error}`);
				continue;
			}
			if (!artifactsRolledBack) {
				rollbackErrors.push(`${record.target} artifacts: rollback conflict`);
				continue;
			}
			if (record.configAdded) {
				try {
					const currentConfig = await readOptionalText(fs, record.configPath);
					const plugins = parseCommunityPlugins(currentConfig);
					const nextPlugins = plugins.filter((id) => id !== pluginId);
					if (nextPlugins.length !== plugins.length) {
						await writeFileAtomically(
							fs,
							record.configPath,
							`${JSON.stringify(nextPlugins, null, 2)}\n`,
						);
					}
				} catch (error) {
					rollbackErrors.push(`${record.target} activation: ${error?.message || error}`);
				}
			}
		}
		if (rollbackErrors.length) {
			throw new Error(`Rollback incomplete: ${rollbackErrors.join(" / ")}`);
		}
		rolledBack = true;
	};

	const configDirs = [
		...new Set(uniqueTargets.map((target) => path.resolve(target, "..", ".."))),
	].toSorted();
	const withLocks = async (operation) => {
		if (lockScope) {
			const missingConfigDir = configDirs.find((configDir) => !lockScope.owns(configDir));
			if (missingConfigDir)
				throw new Error(`Deployment lock scope does not own: ${missingConfigDir}`);
			return operation();
		}
		const releases = [];
		let result;
		let operationError;
		try {
			for (const configDir of configDirs)
				releases.push(await acquireVaultDeployLock({ configDir, fs }));
			result = await operation();
		} catch (error) {
			operationError = error;
		}
		const releaseErrors = [];
		for (const release of releases.toReversed()) {
			try {
				await release();
			} catch (error) {
				releaseErrors.push(error);
			}
		}
		if (operationError) {
			if (releaseErrors.length && operationError instanceof Error)
				operationError.message = `${operationError.message}\nLock release failed: ${releaseErrors.map(String).join(" / ")}`;
			throw operationError;
		}
		if (releaseErrors.length) throw releaseErrors[0];
		return result;
	};
	const rollback = () => withLocks(() => rollbackCompleted());

	try {
		await withLocks(async () => {
			try {
				for (const target of uniqueTargets) {
					const configPath = path.resolve(target, "..", "..", "community-plugins.json");
					const deployment = await deploy({ target, sourceFiles, digests });
					const record = {
						target,
						configPath,
						configAdded: false,
						rollback: deployment.rollback,
						finalize: deployment.finalize,
					};
					completed.push(record);

					const currentConfig = await readOptionalText(fs, configPath);
					const enabled = enableCommunityPlugin(currentConfig, pluginId);
					if (enabled.changed) {
						await writeFileAtomically(fs, configPath, enabled.content);
						record.configAdded = true;
					}

					const verifiedPlugins = parseCommunityPlugins(await fs.readFile(configPath, "utf8"));
					if (!verifiedPlugins.includes(pluginId))
						throw new Error(`Failed to enable the plugin in ${configPath}`);
					log(target);
				}
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				try {
					await rollbackCompleted();
				} catch (rollbackError) {
					error.message = `${error.message}\n${rollbackError.message}`;
				}
				throw error;
			}
		});
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		throw error;
	}
	const finalize = async () => {
		const errors = [];
		for (const record of completed) {
			try {
				await record.finalize?.();
			} catch (error) {
				errors.push(`${record.target}: ${error?.message || error}`);
			}
		}
		if (errors.length) throw new Error(`Finalize incomplete: ${errors.join(" / ")}`);
	};
	return { rollback, finalize };
}
