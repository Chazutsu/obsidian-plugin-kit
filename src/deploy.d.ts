import type * as Fs from "node:fs/promises";

export declare const OBSIDIAN_RELEASE_FILES: readonly ["main.js", "styles.css", "manifest.json"];

export interface CommunityPluginUpdate {
	changed: boolean;
	content: string;
}

export interface ArtifactSet {
	sourceFiles: Map<string, string>;
	digests: Map<string, string>;
}

export interface ArtifactDeployment {
	rollback(): Promise<boolean | void>;
	forceRollback?: () => Promise<boolean | void>;
	finalize?: () => Promise<void>;
}

export interface ObsidianManifest {
	id: string;
	version: string;
	minAppVersion: string;
	isDesktopOnly?: boolean;
	[key: string]: unknown;
}

type FileSystem = typeof Fs;

export declare function enableCommunityPlugin(
	source: string,
	pluginId: string,
): CommunityPluginUpdate;
export declare function validatePluginTarget(target: string, pluginId: string): string;
export declare function prepareObsidianVaults(options: {
	vaults: string[];
	initTarget?: boolean;
	fs?: FileSystem;
}): Promise<
	Array<{
		vault: string;
		canonicalVault: string;
		configDir: string;
		canonicalConfigDir: string;
	}>
>;
export declare function validateObsidianManifest(options: {
	manifest: unknown;
	versions: Record<string, string>;
	expectedId: string;
	mobile?: boolean;
}): ObsidianManifest;
export declare function collectArtifactSet(options: {
	source: string;
	files?: readonly string[];
	fs?: FileSystem;
}): Promise<ArtifactSet>;
export declare function deployArtifactSet(
	options: ArtifactSet & { target: string; fs?: FileSystem },
): Promise<ArtifactDeployment>;
export declare function deployPluginTargets(
	options: ArtifactSet & {
		targets: string[];
		pluginId: string;
		deploy?: (options: ArtifactSet & { target: string }) => Promise<ArtifactDeployment>;
		fs?: FileSystem;
		log?: (target: string) => void;
		initTarget?: boolean;
		lockScope?: {
			owns(configDir: string): boolean;
		};
	},
): Promise<{ rollback: () => Promise<void>; finalize: () => Promise<void> }>;
