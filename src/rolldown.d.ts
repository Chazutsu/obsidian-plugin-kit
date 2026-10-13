import type { RolldownOptions } from "rolldown";

export interface ObsidianPluginConfigOptions {
	input: string;
	output?: string;
	tsconfigFilename?: string;
	external?: NonNullable<RolldownOptions["external"]>;
}

export declare function createObsidianPluginConfig(
	options: ObsidianPluginConfigOptions,
): RolldownOptions;
