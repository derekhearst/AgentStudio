/**
 * The Agent SDK's native AskUserQuestion (#4): the questions as data, how the host answers
 * one, and how an option's preview is rendered without trusting it.
 *
 * AgentStudio used to register its own `ask_user` tool on the in-process MCP server and
 * special-case it in three places. The SDK ships a better one — a preview per option,
 * multi-select, and a free-text "Other" the CLI adds itself — and it reaches the host the
 * way every built-in call does: through `canUseTool`. The host answers it there, by
 * returning the call's input with an `answers` map added. No tool of ours runs at all.
 *
 * Read off the installed SDK (`@anthropic-ai/claude-agent-sdk` 0.3.278, bundled CLI
 * 2.1.278), not assumed:
 *
 *   - `sdk-tools.d.ts` `AskUserQuestionInput`: 1–4 questions, each a `question`, a short
 *     `header` (the CLI calls it a chip, max 12 characters), 2–4 options of
 *     `{ label, description, preview? }` and `multiSelect`. `answers` is typed "User answers
 *     collected by the permission component", keyed by question text. The CLI's `call()`
 *     reads exactly that field back and echoes it on `tool_use_result`
 *     (`AskUserQuestionOutput.answers`, "multi-select answers are comma-separated").
 *   - The CLI's own tool prompt says a recommended option goes first with "(Recommended)" at
 *     the end of its label, and that "Other" is never an option: "Users will always be able
 *     to select Other".
 *   - In `previewFormat: 'html'` the CLI rejects a preview that is a whole document or holds
 *     `<script>`/`<style>`. That is validation of what the model wrote, not a promise about
 *     it, so the page renders previews in a sandbox anyway — see `previewDocument`.
 *
 * Pure and dependency-free (the SDK import is type-only): the engine, the chat host, the
 * chat page and the specs all import it.
 */

import type { PermissionResult, Settings, ToolConfig } from '@anthropic-ai/claude-agent-sdk'

/** The SDK built-in. What a call, its block and its `ask_user` frame are named now. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * `Options.toolConfig` for every engine run. `html` because the card is a web page: the model
 * is told to write each option's preview as a self-contained HTML fragment, which the card
 * renders sandboxed (`previewDocument`). The CLI's default is markdown, for a terminal.
 */
export const ASK_USER_QUESTION_TOOL_CONFIG = {
	askUserQuestion: { previewFormat: 'html' },
} as const satisfies ToolConfig

/**
 * The `Options.settings` for every engine run — `askUserQuestionTimeout` is a Settings field
 * (sdk.d.ts `interface Settings`), not an Option, so it rides the flag-settings layer.
 *
 * `never`: with a timeout the CLI auto-continues with whatever was selected once the user
 * goes idle. On a box that runs while its operator sleeps, that is the run making a
 * decision nobody saw — the failure the /review inbox exists to prevent. `never` is also the
 * SDK's default; it is written down so it cannot drift.
 */
export const ASK_USER_QUESTION_SETTINGS = {
	askUserQuestionTimeout: 'never',
} as const satisfies Settings

/**
 * The retired in-house tool. Nothing calls it any more, but saved transcripts are full of its
 * blocks, and they still render as the question and its answer.
 */
export const LEGACY_ASK_USER_TOOL = 'ask_user'

/** True for a block the chat renders as a question card rather than a tool card. */
export function isAskUserToolName(name: unknown): boolean {
	return name === ASK_USER_QUESTION_TOOL || name === LEGACY_ASK_USER_TOOL
}

export type AskOption = {
	/** Sent back to the model verbatim when chosen, "(Recommended)" and all. */
	label: string
	description?: string
	/** A self-contained HTML fragment showing what the choice produces. Only ever rendered sandboxed. */
	preview?: string
	recommended?: boolean
}

export type AskQuestion = {
	/**
	 * What the answer is keyed by. The question text for AskUserQuestion — the SDK's own key,
	 * unique within a call. Absent on a legacy `ask_user` question, which was keyed by its
	 * header; `answerKey` covers both.
	 */
	key?: string
	/** The short chip label. */
	header: string
	question: string
	options: AskOption[]
	multiSelect?: boolean
	/** Always true for AskUserQuestion — "Other" is automatic. A legacy question could turn it off. */
	allowFreeformInput?: boolean
}

/** What a question's answer is keyed by, on the wire and in `chat_runs.pending_questions`. */
export function answerKey(question: Pick<AskQuestion, 'key' | 'header'>): string {
	return question.key ?? question.header
}

/**
 * Characters of one option's preview kept. Previews travel in the `ask_user` frame, the
 * pending-question row and the review item, so a runaway one is dropped rather than copied
 * three times. Dropped, not cut: half an HTML fragment is not a preview of anything.
 */
export const MAX_PREVIEW_CHARS = 12_000

const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i

/** An option's label as shown: without the "(Recommended)" the model appends, which the card shows as a badge. */
export function optionLabel(label: string): string {
	const stripped = label.replace(RECOMMENDED_SUFFIX, '')
	return stripped.trim().length > 0 ? stripped : label
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readOption(value: unknown, legacy: boolean): AskOption | null {
	const option = asRecord(value)
	const label = str(option?.label)
	if (!option || !label) return null
	const description = str(option.description)
	const preview = legacy ? null : str(option.preview)
	const recommended = option.recommended === true || (!legacy && RECOMMENDED_SUFFIX.test(label))
	return {
		label,
		...(description ? { description } : {}),
		...(preview && preview.length <= MAX_PREVIEW_CHARS ? { preview } : {}),
		...(recommended ? { recommended: true } : {}),
	}
}

/**
 * Read a call's questions: an AskUserQuestion input as the model wrote it, or one already
 * normalised by this function (the `ask_user` frame and the pending row carry that form, so
 * the round trip is stable). Pass `legacy` for a retired `ask_user` block.
 *
 * Tolerant by construction — a block may be half-streamed or years old — so anything that is
 * not a question with text is skipped rather than thrown on.
 */
export function readAskQuestions(input: unknown, options: { legacy?: boolean } = {}): AskQuestion[] {
	const legacy = options.legacy === true
	const record = asRecord(input)
	const raw = Array.isArray(record?.questions) ? record.questions : Array.isArray(input) ? input : []
	const out: AskQuestion[] = []
	for (const entry of raw) {
		const row = asRecord(entry)
		if (!row) continue
		const header = str(row.header) ?? ''
		const question = str(row.question) ?? (legacy ? header : '')
		if (!question) continue
		const questionOptions = (Array.isArray(row.options) ? row.options : [])
			.map((option) => readOption(option, legacy))
			.filter((option): option is AskOption => option !== null)
		if (legacy) {
			out.push({
				header,
				question,
				options: questionOptions,
				allowFreeformInput: row.allowFreeformInput !== false,
			})
			continue
		}
		out.push({
			key: str(row.key) ?? question,
			header,
			question,
			options: questionOptions,
			multiSelect: row.multiSelect === true,
			allowFreeformInput: true,
		})
	}
	return out
}

// ── What the user picked ─────────────────────────────────────────────────────────────────

/** One question's state in the card: the options picked, and the "Other" text. */
export type AskSelection = {
	selected: string[]
	other: string
	/** Whether "Other" is part of the answer. For a single-select question it replaces the options. */
	otherChosen: boolean
}

export const EMPTY_SELECTION: AskSelection = Object.freeze({ selected: [], other: '', otherChosen: false }) as AskSelection

/** Click an option: a single-select question takes it alone, a multi-select one toggles it. */
export function toggleOption(question: AskQuestion, selection: AskSelection, label: string): AskSelection {
	if (!question.multiSelect) return { selected: [label], other: selection.other, otherChosen: false }
	const selected = selection.selected.includes(label)
		? selection.selected.filter((picked) => picked !== label)
		: [...selection.selected, label]
	return { ...selection, selected }
}

/** Type into "Other". On a single-select question that is choosing it over the options. */
export function writeOther(question: AskQuestion, selection: AskSelection, text: string): AskSelection {
	const otherChosen = text.trim().length > 0 || (!question.multiSelect && selection.otherChosen)
	return {
		selected: question.multiSelect ? selection.selected : [],
		other: text,
		otherChosen,
	}
}

/** Focus "Other": a single-select question drops its option, so the answer is what gets typed. */
export function focusOther(question: AskQuestion, selection: AskSelection): AskSelection {
	if (question.multiSelect) return selection
	return { selected: [], other: selection.other, otherChosen: true }
}

/**
 * The answer string for one question, as the SDK takes it: the chosen label, the "Other"
 * text, or — multi-select — every chosen label in option order, then the "Other" text,
 * comma-separated. Empty when nothing is chosen yet.
 */
export function selectionAnswer(question: AskQuestion, selection: AskSelection): string {
	const other = selection.otherChosen ? selection.other.trim() : ''
	if (question.multiSelect) {
		const labels = question.options.map((option) => option.label).filter((label) => selection.selected.includes(label))
		return [...labels, ...(other ? [other] : [])].join(', ')
	}
	if (selection.otherChosen) return other
	return selection.selected[0] ?? ''
}

/**
 * Every question's answer as the card submits it: keyed by `answerKey`, and only the ones
 * with an answer, so a partly answered card sends only what was chosen.
 */
export function selectionAnswers(
	questions: AskQuestion[],
	selections: Readonly<Record<string, AskSelection>>,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const question of questions) {
		const answer = selectionAnswer(question, selections[answerKey(question)] ?? EMPTY_SELECTION)
		if (answer) out[answerKey(question)] = answer
	}
	return out
}

/**
 * The option whose preview the card shows, or null when none of them has one.
 *
 * The one the pointer or keyboard is on, so a user can compare previews before choosing;
 * otherwise the one chosen; otherwise the recommended one; otherwise the first with a
 * preview. An option without a preview never blanks the pane — it keeps the last useful one
 * by falling through to the next rule.
 */
export function previewOption(question: AskQuestion, selection: AskSelection, focused: string | null): AskOption | null {
	const withPreview = question.options.filter((option) => option.preview)
	if (withPreview.length === 0) return null
	return (
		withPreview.find((option) => option.label === focused) ??
		withPreview.find((option) => selection.selected.includes(option.label)) ??
		withPreview.find((option) => option.recommended) ??
		withPreview[0]
	)
}

// ── The host's answer, as the SDK wants it ───────────────────────────────────────────────

/**
 * Re-key answers for the SDK: by question text, only the ones given.
 *
 * `answers` is keyed by `answerKey` — the question text — as the card sends it. The header is
 * accepted as well, because the chat composer's free-text shortcut ("type your answer in the
 * chat") keys by header, and so did everything before this.
 */
export function answersByQuestion(questions: AskQuestion[], answers: Record<string, string>): Record<string, string> {
	// The /review endpoint trims its keys, so a question text with stray whitespace still has
	// to find its answer.
	const trimmed = new Map(Object.entries(answers).map(([key, value]) => [key.trim(), value]))
	const out: Record<string, string> = {}
	for (const question of questions) {
		const raw =
			answers[answerKey(question)] ??
			answers[question.header] ??
			trimmed.get(answerKey(question).trim()) ??
			(question.header.trim() ? trimmed.get(question.header.trim()) : undefined)
		const value = typeof raw === 'string' ? raw.trim() : ''
		if (value) out[question.question] = value
	}
	return out
}

/** One question the SDK asked, handed to whoever can show it to the user. */
export type AskUserRequest = {
	/** The SDK's tool_use id. The card, the `ask_user` frame and the call's result all key on it. */
	toolUseId: string
	questions: AskQuestion[]
	/** Aborts when the run is stopped while the question is waiting. */
	signal: AbortSignal
}

/** The user's answers keyed by `answerKey`, or null when nobody answered. */
export type AskUserReply = { answers: Record<string, string> | null }

/** Shows a question to the user and waits for the answer — in the chat, that is the card and /review. */
export type AskUserHost = (request: AskUserRequest) => Promise<AskUserReply>

/** Why a question was not put to anyone. Each is what the model reads back as the call's error. */
export const ASK_USER_REFUSALS = {
	noHost:
		'Nobody can answer a question in this run. Do not wait for one: make the most reasonable assumption, say what you assumed, and carry on.',
	subagent:
		'A delegated agent cannot ask the user directly. Finish with what you can do, and put the question in your result so the agent that delegated to you can ask it.',
	malformed: 'AskUserQuestion needs at least one question with text.',
	unanswered:
		'The user did not answer this question before the run stopped waiting. Do not answer it for them: carry on only with what does not depend on the answer, or end your turn and say what you need.',
	aborted: 'The run was stopped while this question was waiting for an answer.',
	failed: 'The question could not be shown to the user.',
} as const

export type AskUserQuestionOutcome = {
	permission: PermissionResult
	/** What the SDK was given, keyed by question text; null when the call was refused. */
	answers: Record<string, string> | null
}

/**
 * Answer one AskUserQuestion call from `canUseTool`.
 *
 * Allowed with `updatedInput.answers` when the user answered, denied with a reason the model
 * can act on when not. Never left pending: a run with no host or a subagent's call is refused
 * at once, and a stop settles it through `signal`, whatever the host is doing.
 */
export async function answerAskUserQuestion(call: {
	toolUseId: string
	input: Record<string, unknown>
	signal: AbortSignal
	/** A subagent made the call. It has no one to ask; the old loop refused it too. */
	fromSubagent: boolean
	host?: AskUserHost | null
}): Promise<AskUserQuestionOutcome> {
	const deny = (message: string): AskUserQuestionOutcome => ({ permission: { behavior: 'deny', message }, answers: null })

	if (call.fromSubagent) return deny(ASK_USER_REFUSALS.subagent)
	if (!call.host) return deny(ASK_USER_REFUSALS.noHost)
	const questions = readAskQuestions(call.input)
	if (questions.length === 0) return deny(ASK_USER_REFUSALS.malformed)
	if (call.signal.aborted) return deny(ASK_USER_REFUSALS.aborted)

	let onAbort: () => void = () => {}
	const aborted = new Promise<'aborted'>((resolve) => {
		onAbort = () => resolve('aborted')
		call.signal.addEventListener('abort', onAbort, { once: true })
	})
	let reply: AskUserReply | 'aborted'
	try {
		reply = await Promise.race([call.host({ toolUseId: call.toolUseId, questions, signal: call.signal }), aborted])
	} catch {
		return deny(ASK_USER_REFUSALS.failed)
	} finally {
		call.signal.removeEventListener('abort', onAbort)
	}
	if (reply === 'aborted') return deny(ASK_USER_REFUSALS.aborted)

	const answers = reply.answers ? answersByQuestion(questions, reply.answers) : {}
	if (Object.keys(answers).length === 0) return deny(ASK_USER_REFUSALS.unanswered)
	return { permission: { behavior: 'allow', updatedInput: { ...call.input, answers } }, answers }
}

// ── Previews ─────────────────────────────────────────────────────────────────────────────

/**
 * The policy the preview document carries. Nothing loads from anywhere: an image or a font
 * has to be inline, and an `<img src="https://…">` — the classic way to report back that a
 * page was viewed — is simply not fetched.
 */
export const PREVIEW_CSP =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'"

/**
 * Tags that could act on the document rather than be part of it — a `<meta http-equiv=refresh>`
 * navigates the frame with no click, a `<base>` would replace ours — are turned into text.
 * Belt and braces: the frame is sandboxed with no permissions, which already stops scripts,
 * forms and popups, and the policy above stops loads.
 */
const INERT_TAGS = /<(\/?)(meta|base|link|script|iframe|frame|frameset|object|embed|form|portal)\b/gi

export function neutralizePreviewHtml(fragment: string): string {
	return fragment.replace(INERT_TAGS, '&lt;$1$2')
}

/**
 * The `srcdoc` for one option's preview.
 *
 * The page puts it in an `<iframe sandbox="">`: no scripts, and an opaque origin, so nothing
 * in it can reach the app, its cookies or its remote functions. `<base target="_blank">`
 * sends a link click to a popup, which the sandbox refuses — so a link in a preview goes
 * nowhere rather than navigating the frame.
 */
export function previewDocument(fragment: string): string {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
		'<meta name="referrer" content="no-referrer"><base target="_blank">',
		'<style>html{color-scheme:light}body{margin:0;padding:12px;font:13px/1.5 system-ui,sans-serif;color:#1f2937;background:#fff;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}pre{white-space:pre-wrap}</style>',
		`</head><body>${neutralizePreviewHtml(fragment)}</body></html>`,
	].join('')
}
