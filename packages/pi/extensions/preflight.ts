/**
 * ideation — pi harness preflight.
 *
 * Registers no tools and no flags, so it can never trip pi's
 * `detectExtensionConflicts()` (which keys tool/flag ownership by extension
 * file path, and turns a second owner into a fatal startup error). Its only
 * job is to turn "a tool the skills call is missing" from a cryptic
 * mid-interview failure into a startup notice carrying the exact install line.
 *
 * Claude Code ignores this file — it has Agent, Workflow, and AskUserQuestion
 * built in.
 */
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "ideation-preflight";

type Capability = {
	tool: string;
	install: string;
	without: string;
	/** A tool whose name is present may still be too old to carry the feature
	 * the skills call. When set, `ready` runs against the present tool; false
	 * means installed-but-outdated, reported with `outdated` instead of `without`.
	 * Absent means name presence is enough. */
	ready?: (tool: ToolInfo) => boolean;
	/** Message when the tool is present but `ready` returns false. */
	outdated?: string;
};

/** Source of truth is references/harness-compat.md § 3. */
const CAPABILITIES: Capability[] = [
	{
		tool: "dispatch",
		install: "npm:@nicknisi/pi-subagents",
		without: "every agent dispatch fails — scout, reviewer, plan-critic, waves",
	},
	{
		tool: "ask_user_question",
		install: "npm:@juicesharp/rpiv-ask-user-question",
		without: "interview gates fall back to plain-text lettered options",
	},
	{
		tool: "workflow",
		install: "npm:@nicknisi/pi-workflows",
		without: "the mining front door can't run — intake falls back to the classic interview",
		// The mining script's human gate is the workflow runtime's `ask()`, which
		// shipped in phase 2's pi-workflows. An older version has the tool but no
		// `ask()`, so probe the tool's own description for it (pi-workflows 0.2.2
		// predates ask() and does not advertise it).
		ready: (tool) => /\bask\b/i.test(tool.description ?? ""),
		outdated: "installed, but too old for ask() — update pi-workflows so the mining gate works",
	},
];

const COLUMN = Math.max(...CAPABILITIES.map((capability) => capability.tool.length));

type Gap = { capability: Capability; reason: "absent" | "outdated" };

function gaps(pi: ExtensionAPI): Gap[] {
	const byName = new Map<string, ToolInfo>(pi.getAllTools().map((tool) => [tool.name, tool]));
	const out: Gap[] = [];
	for (const capability of CAPABILITIES) {
		const tool = byName.get(capability.tool);
		if (!tool) out.push({ capability, reason: "absent" });
		else if (capability.ready && !capability.ready(tool)) out.push({ capability, reason: "outdated" });
	}
	return out;
}

function missing(pi: ExtensionAPI): Capability[] {
	return gaps(pi).map((gap) => gap.capability);
}

function render(pi: ExtensionAPI, ctx: ExtensionContext, full: boolean): string[] {
	const { theme } = ctx.ui;
	const gapList = gaps(pi);
	const reasonOf = new Map<Capability, Gap["reason"]>(gapList.map((gap) => [gap.capability, gap.reason]));
	const shown = full ? CAPABILITIES : gapList.map((gap) => gap.capability);
	const headline =
		gapList.length === 0
			? theme.fg("success", "all pi tools installed")
			: theme.fg("warning", `${gapList.length} of ${CAPABILITIES.length} pi tools missing`);

	const lines = [`${theme.fg("accent", "ideation")} ${theme.fg("dim", "·")} ${headline}`];
	for (const capability of shown) {
		const reason = reasonOf.get(capability);
		const mark = reason ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const note = !reason
			? "installed"
			: reason === "outdated"
				? (capability.outdated ?? capability.without)
				: capability.without;
		lines.push(`  ${mark} ${capability.tool.padEnd(COLUMN)}  ${theme.fg("dim", note)}`);
	}
	if (gapList.length > 0) {
		lines.push("");
		for (const gap of gapList) {
			lines.push(`    ${theme.fg("muted", `pi install ${gap.capability.install}`)}`);
		}
	}
	lines.push(theme.fg("dim", "  /ideation-doctor · dismisses on your first message"));
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || missing(pi).length === 0) return;
		ctx.ui.setWidget(WIDGET_ID, render(pi, ctx, false));
	});

	// The notice is a startup reminder, not a permanent fixture.
	pi.on("turn_start", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	});

	pi.registerCommand("ideation-doctor", {
		description: "Check which pi tools the ideation skills need",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				return;
			}
			ctx.ui.setWidget(WIDGET_ID, render(pi, ctx, true));
		},
	});
}
