export async function deployProducts({
	selected,
	repository,
	vaults,
	read,
	collect,
	deployTargets,
	acquireLocks,
	prepareVaults,
	log,
}) {
	const path = await import("node:path");
	const { validateObsidianManifest } = await import("../../src/deploy.mjs");
	const deployments = [];
	await prepareVaults({ vaults });
	const lockScope = await acquireLocks({
		configDirs: vaults.map((vault) => path.join(vault, ".obsidian")),
	});
	let deploymentError;
	try {
		for (const product of selected) {
			const source = path.join(repository, "apps", product.directory);
			const manifest = JSON.parse(await read(path.join(source, "manifest.json"), "utf8"));
			const versions = JSON.parse(await read(path.join(source, "versions.json"), "utf8"));
			validateObsidianManifest({
				manifest,
				versions,
				expectedId: product.id,
				mobile: true,
			});
			const { sourceFiles, digests } = await collect({ source });
			const targets = vaults.map((vault) => path.join(vault, ".obsidian", "plugins", manifest.id));
			const deployment = await deployTargets({
				targets,
				sourceFiles,
				digests,
				pluginId: manifest.id,
				lockScope,
				log,
			});
			deployments.push(deployment);
		}
	} catch (cause) {
		deploymentError = cause instanceof Error ? cause : new Error(String(cause));
		for (const deployment of deployments.toReversed()) await deployment.rollback();
	}
	if (!deploymentError) {
		const finalizeErrors = [];
		for (const deployment of deployments) {
			try {
				await deployment.finalize?.();
			} catch (error) {
				finalizeErrors.push(error?.message ?? String(error));
			}
		}
		if (finalizeErrors.length) {
			deploymentError = new Error(`Suite finalize failed: ${finalizeErrors.join(" / ")}`);
		}
	}
	await lockScope.release();
	if (deploymentError) throw deploymentError;
}
