/**
 * #22 — the composer's `/` command palette: what a command is, and the commands the app
 * offers today.
 *
 * Every command here is an action the app already has a button for. The palette is a
 * keyboard route to them, not a second implementation: each one calls the same handler its
 * button calls. A command is plain data plus a `run`, so commands the Agent SDK reports (a
 * trusted project's own `.claude/commands`, skills) can be listed beside these later, with
 * `source: 'sdk'`, without changing the palette.
 *
 * Pure: no DOM, no remote calls, relative imports only, so the unit spec imports it directly.
 * Whoever builds a command hands it the functions it needs.
 */

import { rankItems, type RankedItem } from './mention-match'
import type { ReasoningEffort } from './reasoning-effort'
import { normalizePermissionMode, type ConversationPermissionMode } from '../engine/permission-mode'

export type ComposerChoice = {
	id: string
	label: string
	detail?: string
	/** The value in effect now; marked in the list. */
	current?: boolean
}

export type CommandArgument =
	/** Free text typed after the command, run when the message is sent: `/research <question>`. */
	| { kind: 'text'; placeholder: string; hint: string }
	/** One of a list, picked from a second menu: `/model <name>`. */
	| {
			kind: 'choice'
			placeholder: string
			/** What one choice is called, for "no model matches …". */
			noun: string
			/** The choices, or null while they are still loading. */
			choices: () => ComposerChoice[] | null
	  }

/** A line to show the user after the command ran, or nothing. */
export type CommandOutcome = string | void

export type ComposerCommand = {
	/** Typed after the slash. Lowercase, no spaces. */
	name: string
	aliases?: readonly string[]
	description: string
	/** Only the app's own commands exist today; the SDK's will say 'sdk'. */
	source?: 'app' | 'sdk'
	argument?: CommandArgument
	/** A short state shown beside the name, such as "on". */
	status?: () => string | null
	/** Why the command cannot run right now, or null when it can. */
	unavailable?: () => string | null
	run: (argument: string) => CommandOutcome | Promise<CommandOutcome>
}

/** The palette's order. Anything not listed goes after these, in the order it was given. */
export const COMMAND_ORDER = ['compact', 'model', 'agent', 'research', 'plan', 'effort', 'attach', 'voice'] as const

export function orderCommands(commands: readonly ComposerCommand[]): ComposerCommand[] {
	const rank = (name: string) => {
		const index = (COMMAND_ORDER as readonly string[]).indexOf(name)
		return index < 0 ? COMMAND_ORDER.length : index
	}
	// A later command with the same name replaces an earlier one (a page overriding a default).
	const byName = new Map<string, ComposerCommand>()
	for (const command of commands) byName.set(command.name, command)
	return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name))
}

/** The command called `name`, or known by it as an alias. Case-insensitive. */
export function findCommand(commands: readonly ComposerCommand[], name: string): ComposerCommand | null {
	const wanted = name.toLowerCase()
	return (
		commands.find((command) => command.name === wanted) ??
		commands.find((command) => command.aliases?.some((alias) => alias.toLowerCase() === wanted)) ??
		null
	)
}

export function rankCommands(query: string, commands: readonly ComposerCommand[]) {
	return rankItems(query, commands, (command) => [command.name, ...(command.aliases ?? [])])
}

/** How many choices a list shows at once. The model catalogue runs to hundreds. */
export const CHOICE_LIMIT = 50

export function rankChoices(query: string, choices: readonly ComposerChoice[], limit = CHOICE_LIMIT) {
	return rankItems(query, choices, (choice) => [choice.label, choice.id], limit)
}

/**
 * A choice list as the menu shows it, and the row it starts on. The two come from the same
 * array, so the starting row is always a row that is on screen.
 *
 * With nothing typed, the list keeps its given order and starts on the value in effect now, so
 * Enter keeps it. A long list is cut to `limit`, and the current value can sort past the cut
 * (most of the model catalogue does): it then leads the list, so it is still shown, marked and
 * highlighted, rather than the highlight landing on whichever row happens to be at its index.
 * With something typed, the best match leads and starts highlighted.
 */
export function choiceMenu(
	query: string,
	choices: readonly ComposerChoice[],
	limit = CHOICE_LIMIT,
): { matches: RankedItem<ComposerChoice>[]; initial: number } {
	const matches = rankChoices(query, choices, limit)
	if (query.trim()) return { matches, initial: 0 }
	const shown = matches.findIndex((match) => match.item.current)
	if (shown >= 0) return { matches, initial: shown }
	const current = choices.find((choice) => choice.current)
	if (!current || limit < 1) return { matches, initial: 0 }
	return { matches: [{ item: current, score: 0, indices: [], key: 0 }, ...matches.slice(0, limit - 1)], initial: 0 }
}

/**
 * The choice a typed name means: an exact label or id first, then the best fuzzy match.
 * `/model sonnet` and `/effort high` work without opening the list.
 */
export function resolveChoice(choices: readonly ComposerChoice[], typed: string): ComposerChoice | null {
	const wanted = typed.trim().toLowerCase()
	if (!wanted) return null
	const exact = choices.find((choice) => choice.id.toLowerCase() === wanted || choice.label.toLowerCase() === wanted)
	return exact ?? rankChoices(wanted, choices, 1)[0]?.item ?? null
}

// ─────────── The commands ───────────

export const REASONING_OPTIONS: ReadonlyArray<{ value: ReasoningEffort; label: string }> = [
	{ value: 'none', label: 'off' },
	{ value: 'minimal', label: 'min' },
	{ value: 'low', label: 'low' },
	{ value: 'medium', label: 'med' },
	{ value: 'high', label: 'high' },
	{ value: 'xhigh', label: 'max' },
]

type Chooser<T> = (value: T) => unknown

export function modelCommand(input: {
	current: () => string
	models: () => ReadonlyArray<{ id: string; name: string }> | null
	pick: Chooser<string>
}): ComposerCommand {
	const choices = (): ComposerChoice[] | null => {
		const models = input.models()
		if (!models) return null
		const current = input.current()
		return models.map((model) => ({ id: model.id, label: model.name, detail: model.id, current: model.id === current }))
	}
	return {
		name: 'model',
		description: 'Switch the model for the next message',
		source: 'app',
		argument: { kind: 'choice', placeholder: '<model>', noun: 'model', choices },
		async run(id) {
			await input.pick(id)
			const label = choices()?.find((choice) => choice.id === id)?.label ?? id
			return `Model: ${label}`
		},
	}
}

export function agentCommand(input: {
	current: () => string | null
	agents: () => ReadonlyArray<{ id: string; name: string; role: string }>
	pick: Chooser<string>
}): ComposerCommand {
	const choices = (): ComposerChoice[] => {
		const current = input.current()
		return input.agents().map((agent) => ({ id: agent.id, label: agent.name, detail: agent.role, current: agent.id === current }))
	}
	return {
		name: 'agent',
		description: 'Hand this conversation to another agent',
		source: 'app',
		argument: { kind: 'choice', placeholder: '<agent>', noun: 'agent', choices },
		async run(id) {
			await input.pick(id)
			return `Agent: ${choices().find((choice) => choice.id === id)?.label ?? id}`
		},
	}
}

export function effortCommand(input: { current: () => ReasoningEffort; pick: Chooser<ReasoningEffort> }): ComposerCommand {
	return {
		name: 'effort',
		aliases: ['reasoning', 'think'],
		description: 'Set how hard the model thinks before answering',
		source: 'app',
		argument: {
			kind: 'choice',
			placeholder: '<level>',
			noun: 'level',
			choices: () => {
				const current = input.current()
				return REASONING_OPTIONS.map((option) => ({ id: option.value, label: option.label, current: option.value === current }))
			},
		},
		async run(id) {
			const option = REASONING_OPTIONS.find((candidate) => candidate.value === id)
			if (!option) return
			await input.pick(option.value)
			return `Reasoning effort: ${option.label}`
		},
	}
}

export function attachCommand(open: () => unknown): ComposerCommand {
	return {
		name: 'attach',
		aliases: ['upload'],
		description: 'Attach files to the next message',
		source: 'app',
		async run() {
			await open()
		},
	}
}

export function voiceCommand(input: { recording: () => boolean; toggle: () => unknown }): ComposerCommand {
	return {
		name: 'voice',
		aliases: ['dictate', 'mic'],
		description: 'Start or stop dictating into the message box',
		source: 'app',
		status: () => (input.recording() ? 'recording' : null),
		async run() {
			await input.toggle()
		},
	}
}

export function compactCommand(compact: () => unknown): ComposerCommand {
	return {
		name: 'compact',
		description: 'Summarise the conversation so far to free up context',
		source: 'app',
		async run() {
			await compact()
		},
	}
}

export function researchCommand(start: (question: string) => unknown): ComposerCommand {
	return {
		name: 'research',
		description: 'Start a deep research run on a question',
		source: 'app',
		argument: { kind: 'text', placeholder: '<question>', hint: 'Type the question to research, then press Enter.' },
		async run(question) {
			await start(question)
		},
	}
}

/** Plan mode toggles against Ask: leaving plan never lands on a looser mode than the default. */
export function nextPlanMode(current: unknown): ConversationPermissionMode {
	return normalizePermissionMode(current) === 'plan' ? 'default' : 'plan'
}

export function planModeCommand(input: {
	current: () => unknown
	setMode: (mode: ConversationPermissionMode) => Promise<unknown> | unknown
}): ComposerCommand {
	return {
		name: 'plan',
		description: 'Turn plan mode on or off (read-only: the agent plans instead of acting)',
		source: 'app',
		status: () => (normalizePermissionMode(input.current()) === 'plan' ? 'on' : null),
		async run() {
			const next = nextPlanMode(input.current())
			await input.setMode(next)
			return next === 'plan'
				? 'Plan mode is on: the agent reads and plans, and changes nothing.'
				: 'Plan mode is off: tools ask for approval as usual.'
		},
	}
}
