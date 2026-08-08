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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "ideation-preflight";

type Capability = {
	tool: string;
	install: string;
	without: string;
};

/** Source of truth is references/harness-compat.md § 3. */
const CAPABILITIES: Capability[] = [
	{
		tool: "dispatch",
		install: "npm:@nicknisi/pi-subagents",
		without: "every agent dispatch fails — scout, reviewer, plan-critic, waves",
	},
	{
		tool: "workflow",
		install: "npm:@quintinshaw/pi-dynamic-workflows",
		without: "autopilot degrades to manual per-phase execution",
	},
	{
		tool: "ask_user_question",
		install: "npm:@juicesharp/rpiv-ask-user-question",
		without: "interview gates fall back to plain-text lettered options",
	},
];

const COLUMN = Math.max(...CAPABILITIES.map((capability) => capability.tool.length));

function missing(pi: ExtensionAPI): Capability[] {
	const present = new Set(pi.getAllTools().map((tool) => tool.name));
	return CAPABILITIES.filter((capability) => !present.has(capability.tool));
}

function render(pi: ExtensionAPI, ctx: ExtensionContext, full: boolean): string[] {
	const { theme } = ctx.ui;
	const gaps = missing(pi);
	const shown = full ? CAPABILITIES : gaps;
	const headline =
		gaps.length === 0
			? theme.fg("success", "all three pi tools installed")
			: theme.fg("warning", `${gaps.length} of ${CAPABILITIES.length} pi tools missing`);

	const lines = [`${theme.fg("accent", "ideation")} ${theme.fg("dim", "·")} ${headline}`];
	for (const capability of shown) {
		const absent = gaps.includes(capability);
		const mark = absent ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const note = absent ? capability.without : "installed";
		lines.push(`  ${mark} ${capability.tool.padEnd(COLUMN)}  ${theme.fg("dim", note)}`);
	}
	if (gaps.length > 0) {
		lines.push("");
		for (const capability of gaps) {
			lines.push(`    ${theme.fg("muted", `pi install ${capability.install}`)}`);
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
