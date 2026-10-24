/**
 * The `/wb` command surface, defined once.
 *
 * Parsing, usage text, argument completion and the workbench actions all derive
 * from this table instead of from a chain of string comparisons plus a second,
 * hand-maintained list in the "unknown subcommand" message. A command that exists
 * in the table is dispatchable, completable and documented; one that does not does
 * not appear anywhere.
 */

/** One argument a subcommand accepts. */
export interface CommandArgument {
	name: string;
	/** Shown in usage; descriptive text only, since no argument offers a literal choice list anymore. */
	required: boolean;
	description: string;
}

/** One registered subcommand. */
export interface CommandSpec {
	name: string;
	/** Shown in the command description and the usage listing. */
	summary: string;
	arguments: readonly CommandArgument[];
	/**
	 * True when the command changes durable state.
	 *
	 * Sensitive commands refuse to act without a UI: previewing is the whole point
	 * of the confirmation, and a headless context cannot have confirmed anything.
	 */
	mutates: boolean;
}

/** Every supported `/wb` subcommand, in help order. */
export const WB_COMMANDS: readonly CommandSpec[] = [
	{
		name: "",
		summary: "Open the workbench (status text when no UI is available)",
		arguments: [],
		mutates: false,
	},
	{
		name: "status",
		summary: "Read-only summary: binding, project state, worker reachability, active tasks",
		arguments: [],
		mutates: false,
	},
	{
		name: "setup",
		summary: "Preview and apply this project's bridge integration",
		arguments: [],
		mutates: true,
	},
	{
		name: "init",
		summary: "Migrate and enable project state without changing configuration",
		arguments: [],
		mutates: true,
	},
	{
		name: "bind",
		summary: "Bind this project to a verified WorkBuddy session",
		arguments: [],
		mutates: true,
	},
	{
		name: "send",
		summary: "Confirm and submit a pending delegation draft reported by the headless wb_task fallback",
		arguments: [{ name: "requestId", required: true, description: "RequestId the fallback reported for the pending round" }],
		mutates: true,
	},
	{
		name: "tasks",
		summary: "List this project's tasks, or one task's details",
		arguments: [{ name: "task", required: false, description: "Task id to show in detail" }],
		mutates: false,
	},
	{
		name: "background",
		summary: "Switch one task's current round to background delivery; the result arrives as a follow-up",
		arguments: [{ name: "task", required: true, description: "Task id whose current round should report in the background" }],
		mutates: true,
	},
	{
		name: "results",
		summary: "Show this OMP session's unconsumed result notifications",
		arguments: [{ name: "task", required: false, description: "Task id to inspect in detail; omit to list every pending result" }],
		mutates: false,
	},
	{
		name: "repair",
		summary: "Rebuild one failed round's receipt from the persisted outcome, without sending anything",
		arguments: [{ name: "task", required: false, description: "Task id to repair; omit to list repairable rounds" }],
		mutates: true,
	},
	{
		name: "cancel",
		summary: "Cancel one delegated task owned by this OMP process",
		arguments: [{ name: "task", required: false, description: "Task id; omit to choose from this process's tasks" }],
		mutates: true,
	},
	{
		name: "release",
		summary: "Release one quarantined round after verifying its WorkBuddy execution stopped",
		arguments: [{ name: "task", required: false, description: "Task id with a quarantined round; omit to choose from the list" }],
		mutates: true,
	},
	{
		name: "doctor",
		summary: "Read-only diagnosis of binding, queue, storage and worker health",
		arguments: [],
		mutates: false,
	},
	{
		name: "usage",
		summary: "Print this command reference",
		arguments: [],
		mutates: false,
	},
] as const;

/** A parsed `/wb` invocation. */
export interface ParsedCommand {
	/** The matched subcommand, or `null` for something unrecognized. */
	spec: CommandSpec | null;
	/** The raw subcommand the user typed. */
	subcommand: string;
	/** Positional arguments after the subcommand. */
	positional: string[];
	/** `--flag value` pairs, with the leading dashes stripped. */
	flags: Record<string, string>;
	/** Usage line for the matched subcommand, ready to print. */
	usage: string;
}

/** Builds the usage string for one subcommand. */
export function usageOf(spec: CommandSpec): string {
	const parts = [`/wb`, spec.name].filter((part) => part.length > 0);
	for (const argument of spec.arguments) {
		parts.push(argument.required ? `<${argument.name}>` : `[<${argument.name}>]`);
	}
	return parts.join(" ");
}

/**
 * The full help text, derived from the table rather than maintained beside it.
 *
 * Every registered command runs in this build, so the reference simply lists
 * them; a separate "planned" section would be a promise nothing keeps.
 */
export function usageListing(): string {
	return [
		"WorkBuddy bridge commands:",
		...WB_COMMANDS.map((spec) => `  ${usageOf(spec).padEnd(38)} ${spec.summary}`),
	].join("\n");
}

/**
 * One-line description for the registered `/wb` command itself.
 *
 * Derived from the table for the same reason the usage listing is: a hand-written
 * summary beside the table drifts as soon as a subcommand is added or removed,
 * and then advertises commands that no longer exist while hiding real ones.
 */
export function commandDescription(): string {
	const names = WB_COMMANDS.map((spec) => spec.name).filter((name) => name.length > 0);
	return `WorkBuddy bridge: open the workbench, or run ${names.join("/")}`;
}

/**
 * Parses one `/wb` argument string against the table.
 *
 * An empty argument string means "open the workbench", which is the entry point a
 * bare `/wb` has always implied; it is therefore the empty-named spec rather than a
 * special case in the caller.
 */
export function parseCommand(args: string): ParsedCommand {
	const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
	const subcommand = tokens[0] ?? "";
	const rest = tokens.slice(1);
	const spec = WB_COMMANDS.find((candidate) => candidate.name === subcommand) ?? null;

	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index]!;
		if (token.startsWith("--")) {
			const name = token.slice(2);
			const value = rest[index + 1];
			// A flag with no following value records an empty string rather than
			// `undefined`, so `--package` alone is a validation error at the handler.
			flags[name] = value === undefined || value.startsWith("--") ? "" : value;
			if (value !== undefined && !value.startsWith("--")) {
				index++;
			}
			continue;
		}
		positional.push(token);
	}

	return {
		spec,
		subcommand,
		positional,
		flags,
		usage: spec === null ? "/wb <subcommand>" : usageOf(spec),
	};
}


/**
 * The choices a caller may complete for the current position.
 *
 * Only the registered subcommand names are offered: task ids and request ids are
 * supplied by the host from a snapshot, not invented here.
 */
export function completionChoices(prefix: string): string[] {
	const trimmed = prefix.trimStart();
	if (!trimmed.includes(" ") && !trimmed.includes("\t")) {
		return WB_COMMANDS.filter((spec) => spec.name.length > 0 && spec.name.startsWith(trimmed)).map(
			(spec) => spec.name,
		);
	}
	return [];
}
