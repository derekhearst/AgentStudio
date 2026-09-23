<script lang="ts">
	/**
	 * Memory control panel — the management half of the palace (issue #37).
	 *
	 * Two tabs:
	 *   · Exclusion rules — the deny list the miner checks before it embeds or inserts.
	 *     Built-in credential rules ship enabled and can be disabled but not deleted.
	 *   · Mined conversations — delete everything mined from one conversation at once.
	 */
	import {
		deleteMemoryExclusionRuleCommand,
		forgetConversationMemoriesCommand,
		listMemoryExclusionRulesQuery,
		listMinedConversationsQuery,
		saveMemoryExclusionRuleCommand,
		testMemoryExclusionRulesCommand,
		toggleMemoryExclusionRuleCommand,
		type MemoryExclusionRuleRow,
		type MemoryMinedConversationRow,
	} from '$lib/memory/memory.remote';
	import { relativeTime } from '$lib/util/relative-time';
	import { confirmDialog } from '$lib/ui/confirm-dialog.svelte';

	let {
		open = $bindable(false),
		onChanged,
	}: {
		open?: boolean;
		/** Fired after a destructive change so the parent can refresh palace counts. */
		onChanged?: () => void;
	} = $props();

	let tab = $state<'rules' | 'conversations'>('rules');
	let rules = $state<MemoryExclusionRuleRow[]>([]);
	let conversations = $state<MemoryMinedConversationRow[]>([]);
	let loading = $state(false);

	// --- rule editor -----------------------------------------------------------
	let editingId = $state<string | null>(null);
	let form = $state({ name: '', description: '', kind: 'regex' as 'regex' | 'substring', pattern: '' });
	let formError = $state<string | null>(null);
	let saving = $state(false);

	// --- rule tester -----------------------------------------------------------
	let sample = $state('');
	let testResult = $state<{
		matched: boolean;
		ruleName?: string;
		sample?: string;
		timedOut?: boolean;
		busy?: boolean;
	} | null>(null);
	let testing = $state(false);

	let busyConversationId = $state<string | null>(null);

	$effect(() => {
		if (open) void load();
	});

	async function load() {
		loading = true;
		try {
			const [ruleRows, convoRows] = await Promise.all([
				listMemoryExclusionRulesQuery() as Promise<MemoryExclusionRuleRow[]>,
				listMinedConversationsQuery() as Promise<MemoryMinedConversationRow[]>,
			]);
			rules = ruleRows;
			conversations = convoRows;
		} finally {
			loading = false;
		}
	}

	async function refreshRules() {
		await listMemoryExclusionRulesQuery().refresh();
		rules = (await listMemoryExclusionRulesQuery()) as MemoryExclusionRuleRow[];
	}

	async function refreshConversations() {
		await listMinedConversationsQuery().refresh();
		conversations = (await listMinedConversationsQuery()) as MemoryMinedConversationRow[];
	}

	function resetForm() {
		editingId = null;
		form = { name: '', description: '', kind: 'regex', pattern: '' };
		formError = null;
	}

	function startEdit(rule: MemoryExclusionRuleRow) {
		editingId = rule.id;
		form = {
			name: rule.name,
			description: rule.description ?? '',
			kind: rule.kind,
			pattern: rule.pattern,
		};
		formError = null;
	}

	async function save() {
		if (saving) return;
		if (form.name.trim().length === 0 || form.pattern.trim().length === 0) {
			formError = 'Name and pattern are both required.';
			return;
		}
		saving = true;
		formError = null;
		try {
			const result = await saveMemoryExclusionRuleCommand({
				...(editingId ? { id: editingId } : {}),
				name: form.name.trim(),
				description: form.description.trim() || undefined,
				kind: form.kind,
				pattern: form.pattern.trim(),
				// No `enabled`: a new rule starts on, and an edit leaves the rule's switch as it is.
			});
			if (!result.ok) {
				formError = result.error;
				return;
			}
			resetForm();
			await refreshRules();
		} catch (err) {
			formError = err instanceof Error ? err.message : 'Save failed.';
		} finally {
			saving = false;
		}
	}

	async function toggle(rule: MemoryExclusionRuleRow) {
		await toggleMemoryExclusionRuleCommand({ id: rule.id, enabled: !rule.enabled });
		await refreshRules();
	}

	async function remove(rule: MemoryExclusionRuleRow) {
		const ok = await confirmDialog({
			title: `Delete the exclusion rule "${rule.name}"?`,
			message: 'The miner will stop skipping what this rule matched.',
			confirmLabel: 'Delete',
			variant: 'danger'
		});
		if (!ok) return;
		const result = await deleteMemoryExclusionRuleCommand({ id: rule.id });
		if (!result.ok) {
			formError = result.error;
			return;
		}
		if (editingId === rule.id) resetForm();
		await refreshRules();
	}

	async function runTest() {
		if (testing || sample.trim().length === 0) return;
		testing = true;
		try {
			testResult = await testMemoryExclusionRulesCommand({ sample });
		} finally {
			testing = false;
		}
	}

	async function forget(row: MemoryMinedConversationRow) {
		const label = row.title ?? 'this conversation';
		const ok = await confirmDialog({
			title: `Forget everything mined from "${label}"?`,
			message: `${row.drawerCount} drawer${row.drawerCount === 1 ? '' : 's'} across ${row.roomCount} room${row.roomCount === 1 ? '' : 's'} will be deleted. The chat itself is not touched. This cannot be undone.`,
			confirmLabel: 'Forget',
			variant: 'danger'
		});
		if (!ok) return;
		busyConversationId = row.conversationId;
		try {
			await forgetConversationMemoriesCommand({ conversationId: row.conversationId });
			await refreshConversations();
			onChanged?.();
		} finally {
			busyConversationId = null;
		}
	}
</script>

{#if open}
	<button class="control-scrim" onclick={() => (open = false)} aria-label="Close memory management" type="button"
	></button>
	<div class="control-panel" role="dialog" aria-label="Memory management">
		<header class="control-panel__head">
			<div class="control-panel__title">
				<span class="control-panel__label">Manage memory</span>
				<span class="control-panel__sub">What gets remembered, and what gets forgotten</span>
			</div>
			<button class="console-iconbtn" onclick={() => (open = false)} aria-label="Close" title="Close">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"
					><path d="M18 6L6 18M6 6l12 12" /></svg
				>
			</button>
		</header>

		<div class="control-panel__tabs">
			<button class="control-panel__tab" class:is-active={tab === 'rules'} onclick={() => (tab = 'rules')}>
				Exclusion rules
				<span class="control-panel__tab-count">{rules.filter((r) => r.enabled).length}</span>
			</button>
			<button
				class="control-panel__tab"
				class:is-active={tab === 'conversations'}
				onclick={() => (tab = 'conversations')}
			>
				Mined conversations
				<span class="control-panel__tab-count">{conversations.length}</span>
			</button>
		</div>

		<div class="control-panel__body">
			{#if loading}
				<div class="control-panel__loading"><span class="loading loading-spinner loading-sm text-primary"></span></div>
			{:else if tab === 'rules'}
				<p class="control-panel__intro">
					The miner checks every turn against these patterns <strong>before</strong> it embeds or stores anything. A
					match drops the turn entirely — it never reaches the embedding provider and never becomes a drawer. A
					message that matches is not used to search memory either. The credential rules are built in; you can
					disable or reword them, but not delete them.
				</p>

				<ul class="rule-list">
					{#each rules as rule (rule.id)}
						<li class="rule" class:is-off={!rule.enabled}>
							<div class="rule__head">
								<label class="rule__toggle">
									<input type="checkbox" checked={rule.enabled} onchange={() => toggle(rule)} />
									<span class="rule__name">{rule.name}</span>
								</label>
								{#if rule.builtin}
									<span class="rule__badge">built-in</span>
								{/if}
								<span class="rule__kind">{rule.kind}</span>
								{#if rule.hitCount > 0}
									<span class="rule__hits" title="Turns this rule has dropped">
										{rule.hitCount} blocked · {relativeTime(rule.lastHitAt)}
									</span>
								{/if}
								<div class="rule__actions">
									<button class="console-pill" onclick={() => startEdit(rule)}>Edit</button>
									{#if !rule.builtin}
										<button class="console-pill rule__delete" onclick={() => remove(rule)}>Delete</button>
									{/if}
								</div>
							</div>
							{#if rule.description}
								<div class="rule__desc">{rule.description}</div>
							{/if}
							<code class="rule__pattern">{rule.pattern}</code>
							{#if rule.problem}
								<p class="rule__problem">{rule.problem}</p>
							{/if}
						</li>
					{:else}
						<li class="control-panel__empty">No exclusion rules yet.</li>
					{/each}
				</ul>

				<section class="rule-form">
					<div class="rule-form__head">{editingId ? 'Edit rule' : 'New rule'}</div>
					<div class="rule-form__grid">
						<label class="rule-form__field">
							<span>Name</span>
							<input type="text" bind:value={form.name} maxlength="80" placeholder="Home address" />
						</label>
						<label class="rule-form__field">
							<span>Match</span>
							<select bind:value={form.kind}>
								<option value="regex">regex</option>
								<option value="substring">substring</option>
							</select>
						</label>
					</div>
					<label class="rule-form__field">
						<span>Pattern</span>
						<input
							type="text"
							bind:value={form.pattern}
							maxlength="400"
							placeholder={form.kind === 'regex' ? '\\b\\d{3}-\\d{2}-\\d{4}\\b' : 'my street address'}
						/>
					</label>
					<label class="rule-form__field">
						<span>Note</span>
						<input type="text" bind:value={form.description} maxlength="240" placeholder="Optional description" />
					</label>
					{#if formError}
						<p class="rule-form__error">{formError}</p>
					{/if}
					<div class="rule-form__actions">
						<button class="btn btn-xs btn-primary" onclick={save} disabled={saving}>
							{saving ? 'Saving…' : editingId ? 'Save rule' : 'Add rule'}
						</button>
						{#if editingId}
							<button class="btn btn-xs btn-ghost" onclick={resetForm} disabled={saving}>Cancel</button>
						{/if}
					</div>
				</section>

				<section class="rule-test">
					<div class="rule-form__head">Test the deny list</div>
					<p class="control-panel__intro">
						Paste something you would not want remembered and check that a rule catches it. Nothing here is stored.
					</p>
					<textarea
						bind:value={sample}
						rows="3"
						placeholder="e.g. DATABASE_URL=postgresql://user:hunter2@db.internal:5432/app"
					></textarea>
					<div class="rule-form__actions">
						<button class="btn btn-xs" onclick={runTest} disabled={testing || sample.trim().length === 0}>
							{testing ? 'Checking…' : 'Check'}
						</button>
						{#if testResult}
							{#if testResult.matched && testResult.timedOut}
								<span class="rule-test__hit"
									>Blocked: “{testResult.ruleName}” could not finish checking this in time, so it would be treated as a
									match.</span
								>
							{:else if testResult.matched}
								<span class="rule-test__hit">Blocked by “{testResult.ruleName}” (matched {testResult.sample})</span>
							{:else if testResult.busy}
								<span class="rule-test__miss">Another check is still running. Try again in a moment.</span>
							{:else}
								<span class="rule-test__miss">No rule matches — this would be mined.</span>
							{/if}
						{/if}
					</div>
				</section>
			{:else}
				<p class="control-panel__intro">
					Each row is one conversation's footprint in the palace. Forgetting deletes its rooms, closets, and drawers
					— and any wing left empty as a result. The chat transcript itself is untouched, and what it held so far
					stays forgotten; anything said in it afterwards is remembered as usual, unless an exclusion rule blocks it.
				</p>
				<ul class="convo-list">
					{#each conversations as row (row.conversationId)}
						<li class="convo">
							<div class="convo__main">
								<a class="convo__title" href={`/chat/${row.conversationId}`}>
									{row.title ?? 'Untitled conversation'}
								</a>
								<span class="convo__meta">
									{row.drawerCount} drawer{row.drawerCount === 1 ? '' : 's'} · {row.roomCount} room{row.roomCount ===
									1
										? ''
										: 's'} · mined {relativeTime(row.lastMinedAt)}
								</span>
							</div>
							<button
								class="console-pill convo__forget"
								onclick={() => forget(row)}
								disabled={busyConversationId === row.conversationId}
							>
								{busyConversationId === row.conversationId ? 'Forgetting…' : 'Forget'}
							</button>
						</li>
					{:else}
						<li class="control-panel__empty">No conversations have been mined yet.</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.control-scrim {
		position: fixed;
		inset: 0;
		background: color-mix(in oklab, black 45%, transparent);
		border: 0;
		z-index: 40;
	}

	.control-panel {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(760px, calc(100vw - 32px));
		max-height: min(80vh, 760px);
		display: flex;
		flex-direction: column;
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 12px;
		box-shadow: 0 24px 64px color-mix(in oklab, black 45%, transparent);
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
		z-index: 41;
		overflow: hidden;
	}

	.control-panel__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--color-base-300);
	}

	.control-panel__title {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.control-panel__label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		font-weight: 600;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.control-panel__sub {
		font-size: 12px;
		color: var(--color-base-content);
	}

	.control-panel__tabs {
		display: flex;
		gap: 4px;
		padding: 8px 14px 0;
		border-bottom: 1px solid var(--color-base-300);
	}

	.control-panel__tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px solid transparent;
		border-bottom: 0;
		border-radius: 6px 6px 0 0;
		background: transparent;
		font-family: inherit;
		font-size: 11.5px;
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
		cursor: pointer;
	}

	.control-panel__tab.is-active {
		border-color: var(--color-base-300);
		background: var(--color-base-200);
		color: var(--color-base-content);
	}

	.control-panel__tab-count {
		font-size: 9.5px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--color-base-300);
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
	}

	.control-panel__body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.control-panel__loading {
		display: flex;
		justify-content: center;
		padding: 24px 0;
	}

	.control-panel__intro {
		margin: 0;
		font-size: 11px;
		line-height: 1.5;
		color: color-mix(in oklab, var(--color-base-content) 62%, transparent);
	}

	.control-panel__empty {
		padding: 12px;
		text-align: center;
		font-size: 11px;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.rule-list,
	.convo-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.rule {
		padding: 8px 10px;
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		background: color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.rule.is-off {
		opacity: 0.55;
	}

	.rule__head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.rule__toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}

	.rule__name {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-base-content);
	}

	.rule__badge {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		padding: 1px 5px;
		border-radius: 3px;
		background: color-mix(in oklab, var(--color-warning) 18%, transparent);
		color: var(--color-warning);
	}

	.rule__kind {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.rule__hits {
		font-size: 10px;
		color: var(--color-error);
	}

	.rule__actions {
		margin-left: auto;
		display: flex;
		gap: 4px;
	}

	.rule__delete {
		color: var(--color-error);
		border-color: color-mix(in oklab, var(--color-error) 40%, var(--color-base-300));
	}

	.rule__desc {
		font-size: 10.5px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
	}

	.rule__problem {
		margin: 0;
		font-size: 10.5px;
		color: var(--color-warning);
	}

	.rule__pattern {
		display: block;
		padding: 4px 6px;
		border-radius: 4px;
		background: var(--color-base-200);
		font-size: 10.5px;
		color: color-mix(in oklab, var(--color-base-content) 80%, transparent);
		word-break: break-all;
	}

	.rule-form,
	.rule-test {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px;
		border: 1px dashed var(--color-base-300);
		border-radius: 8px;
	}

	.rule-form__head {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		font-weight: 600;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.rule-form__grid {
		display: grid;
		grid-template-columns: 1fr 140px;
		gap: 8px;
	}

	.rule-form__field {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.rule-form__field span {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
	}

	.rule-form__field input,
	.rule-form__field select,
	.rule-test textarea {
		width: 100%;
		padding: 5px 8px;
		border: 1px solid var(--color-base-300);
		border-radius: 5px;
		background: var(--color-base-200);
		font-family: inherit;
		font-size: 11.5px;
		color: var(--color-base-content);
	}

	.rule-test textarea {
		resize: vertical;
	}

	.rule-form__actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.rule-form__error {
		margin: 0;
		font-size: 11px;
		color: var(--color-error);
	}

	.rule-test__hit {
		font-size: 11px;
		color: var(--color-success);
	}

	.rule-test__miss {
		font-size: 11px;
		color: var(--color-warning);
	}

	.convo {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		background: color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
	}

	.convo__main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.convo__title {
		font-size: 12px;
		color: var(--color-base-content);
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.convo__title:hover {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.convo__meta {
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.convo__forget {
		flex: 0 0 auto;
		color: var(--color-error);
		border-color: color-mix(in oklab, var(--color-error) 40%, var(--color-base-300));
	}

	@media (max-width: 47.99rem) {
		.control-panel {
			width: calc(100vw - 16px);
			max-height: 88vh;
		}

		.rule-form__grid {
			grid-template-columns: 1fr;
		}
	}
</style>
