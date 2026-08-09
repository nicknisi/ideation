/**
 * ideation — pi engine host.
 *
 * Registers the `run_ideation_contract` tool: runs workflows/execute-contract.mjs
 * (the same engine Claude Code runs via its Workflow tool) with agent()
 * backed by the first-party in-process spawn runtime from @nicknisi/pi-shared.
 * The shim lives in workflows/engine-host.mjs — dependency-free and unit-tested;
 * this file is only the wiring.
 *
 * Stage agents come from agents/*.md at the plugin root: the file body becomes
 * the spawn's systemPrompt, and engine-host.mjs owns the tool allowlists. No
 * agent registry, no .pi/agents copy step.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentRuntime } from "@nicknisi/pi-shared";
import { Type } from "typebox";
import { runContractEngine } from "../workflows/engine-host.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const Phase = Type.Object({
	title: Type.String(),
	specPath: Type.String(),
	prereqs: Type.Optional(Type.Array(Type.String())),
	risk: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.String())),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_ideation_contract",
		label: "Run Ideation Contract",
		description:
			"Run the ideation execute-contract engine: dispatch a contract's phases in dependency-ordered waves, each phase as scout → build → review ⇄ fix → commit child-agent stages, and return the structured summary { completed, noops, failed, skipped, results }. Synchronous — the result comes back as this tool's result. Used by /ideation:autopilot.",
		promptSnippet: "Run an approved ideation contract's phases through the engine",
		promptGuidelines: [
			"Call with the manifest autopilot builds from contract-data.json (projectName, slug, projectDir, strict, phases, completedPhases).",
			"The result is the engine summary; failed phases list their stage and reason in results[].",
		],
		parameters: Type.Object({
			projectName: Type.String(),
			slug: Type.String(),
			projectDir: Type.String(),
			strict: Type.Optional(Type.Boolean()),
			phases: Type.Array(Phase),
			completedPhases: Type.Optional(Type.Array(Type.String())),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			const runtime = createSubagentRuntime({ namespace: "ideation-engine" });
			const summary = await runContractEngine(params, {
				spawn: opts => runtime.spawn(opts),
				pluginRoot: PLUGIN_ROOT,
				onLog: message => {
					onUpdate?.({ content: [{ type: "text", text: message }] });
				},
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
				details: { summary },
			};
		},
	});
}
