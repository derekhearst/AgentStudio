<script lang="ts">
	import {
		MONITOR_DEFAULT_MAX_CHECKS,
		MONITOR_MAX_DEADLINE_DAYS,
		MONITOR_OBSERVABLE_TOOLS,
		type MonitorAction,
		type MonitorCompare,
		type MonitorObservableTool
	} from '$lib/monitors/condition';
	import { createMonitorCommand } from '$lib/monitors/monitors.remote';

	let { onCreated }: { onCreated: (message: string) => void } = $props();

	const INTERVALS: Array<{ value: number; label: string }> = [
		{ value: 60, label: 'every minute' },
		{ value: 300, label: 'every 5 minutes' },
		{ value: 900, label: 'every 15 minutes' },
		{ value: 3600, label: 'hourly' },
		{ value: 21600, label: 'every 6 hours' },
		{ value: 86400, label: 'daily' }
	];

	const COMPARES: Array<{ value: MonitorCompare; label: string }> = [
		{ value: 'changed', label: 'changed since last check' },
		{ value: 'equals', label: 'equals' },
		{ value: 'not_equals', label: 'does not equal' },
		{ value: 'contains', label: 'contains' },
		{ value: 'not_contains', label: 'does not contain' },
		{ value: 'matches', label: 'matches regex' },
		{ value: 'not_empty', label: 'is non-empty' }
	];

	const ACTIONS: Array<{ value: MonitorAction; label: string }> = [
		{ value: 'review_item', label: 'Open a review item' },
		{ value: 'push', label: 'Send a push notification' },
		{ value: 'start_conversation', label: 'Start a conversation with a seeded prompt' },
		{ value: 'run_automation', label: 'Run an automation' }
	];

	const ARG_PLACEHOLDERS: Partial<Record<MonitorObservableTool, string>> = {
		web_fetch: '{ "url": "https://example.com/releases" }',
		web_search: '{ "query": "acme widgets release" }',
		Grep: '{ "pattern": "TODO", "path": "src" }',
		Read: '{ "file_path": "notes.md" }',
		file_info: '{ "path": "notes.md" }',
		Glob: '{ "pattern": "**/*", "path": "." }',
		git_status: '{}',
		git_log: '{ "max": 5 }',
		git_diff: '{}',
		list_pull_requests: '{ "owner": "acme", "repo": "widgets" }',
		get_pull_request: '{ "pullRequestId": "00000000-0000-0000-0000-000000000000" }',
		list_projects: '{}'
	};

	let name = $state('');
	let conditionKind = $state<'tool_result' | 'model_question'>('tool_result');
	let tool = $state<MonitorObservableTool>('web_fetch');
	let argsText = $state('{ "url": "https://example.com" }');
	let extract = $state('text');
	let compare = $state<MonitorCompare>('changed');
	let compareValue = $state('');
	let question = $state('');
	let contextTool = $state<MonitorObservableTool>('web_fetch');
	let contextArgsText = $state('{ "url": "https://example.com" }');
	let action = $state<MonitorAction>('review_item');
	let prompt = $state('');
	let automationId = $state('');
	let title = $state('');
	let body = $state('');
	let intervalSeconds = $state(900);
	let deadlineDays = $state(7);
	let maxChecks = $state(MONITOR_DEFAULT_MAX_CHECKS);
	let oneShot = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	const needsOperand = $derived(compare !== 'changed' && compare !== 'not_empty');

	function parseArgs(text: string, label: string): Record<string, unknown> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`${label} must be valid JSON`);
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error(`${label} must be a JSON object`);
		}
		return parsed as Record<string, unknown>;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		submitting = true;
		try {
			const condition =
				conditionKind === 'tool_result'
					? {
							kind: 'tool_result' as const,
							tool,
							args: parseArgs(argsText, 'Arguments'),
							extract: extract.trim() || undefined,
							compare,
							value: needsOperand ? compareValue : undefined
						}
					: {
							kind: 'model_question' as const,
							question: question.trim(),
							context: [{ tool: contextTool, args: parseArgs(contextArgsText, 'Context arguments') }]
						};

			await createMonitorCommand({
				name: name.trim(),
				condition,
				action,
				actionConfig: {
					prompt: prompt.trim() || undefined,
					automationId: automationId.trim() || undefined,
					title: title.trim() || undefined,
					body: body.trim() || undefined
				},
				intervalSeconds,
				deadlineDays,
				maxChecks,
				oneShot
			});
			onCreated(`Monitor "${name.trim()}" is active — it expires in ${deadlineDays} day(s) or after ${maxChecks} checks.`);
			name = '';
			question = '';
			prompt = '';
			compareValue = '';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Unable to create the monitor.';
		} finally {
			submitting = false;
		}
	}
</script>

<form class="card border-base-300 bg-base-100 rounded-2xl border" onsubmit={submit}>
	<div class="card-body gap-3 p-4">
		<div>
			<h2 class="text-sm font-semibold">New monitor</h2>
			<p class="text-xs opacity-60">
				Watch for a condition and act when it changes. Every monitor expires — at most
				{MONITOR_MAX_DEADLINE_DAYS} days, and only ever extended on request.
			</p>
		</div>

		{#if error}
			<div role="alert" class="alert alert-error py-2 text-xs">{error}</div>
		{/if}

		<label class="form-control">
			<span class="label-text text-xs">Name</span>
			<input
				class="input input-sm input-bordered w-full"
				bind:value={name}
				required
				maxlength="200"
				placeholder="Release notes page changes"
			/>
		</label>

		<label class="form-control">
			<span class="label-text text-xs">Condition</span>
			<select class="select select-sm select-bordered w-full" bind:value={conditionKind}>
				<option value="tool_result">Compare a tool result (free, deterministic)</option>
				<option value="model_question">Ask a cheap model a yes/no question (costs tokens per check)</option>
			</select>
		</label>

		{#if conditionKind === 'tool_result'}
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs">Tool</span>
					<select class="select select-sm select-bordered w-full" bind:value={tool}>
						{#each MONITOR_OBSERVABLE_TOOLS as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
				</label>
				<label class="form-control">
					<span class="label-text text-xs">Extract (dotted path, optional)</span>
					<input class="input input-sm input-bordered w-full" bind:value={extract} placeholder="text" />
				</label>
			</div>
			<label class="form-control">
				<span class="label-text text-xs">Arguments (JSON)</span>
				<textarea
					class="textarea textarea-sm textarea-bordered w-full font-mono text-xs"
					rows="2"
					bind:value={argsText}
					placeholder={ARG_PLACEHOLDERS[tool] ?? '{}'}
				></textarea>
			</label>
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs">Fires when the value…</span>
					<select class="select select-sm select-bordered w-full" bind:value={compare}>
						{#each COMPARES as c (c.value)}
							<option value={c.value}>{c.label}</option>
						{/each}
					</select>
				</label>
				{#if needsOperand}
					<label class="form-control">
						<span class="label-text text-xs">Operand</span>
						<input class="input input-sm input-bordered w-full" bind:value={compareValue} />
					</label>
				{/if}
			</div>
		{:else}
			<label class="form-control">
				<span class="label-text text-xs">Yes/no question</span>
				<textarea
					class="textarea textarea-sm textarea-bordered w-full"
					rows="2"
					bind:value={question}
					required
					placeholder="Have all CI checks on pull request 412 finished successfully?"
				></textarea>
			</label>
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs">Context tool</span>
					<select class="select select-sm select-bordered w-full" bind:value={contextTool}>
						{#each MONITOR_OBSERVABLE_TOOLS as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
				</label>
				<label class="form-control">
					<span class="label-text text-xs">Context arguments (JSON)</span>
					<input
						class="input input-sm input-bordered w-full font-mono text-xs"
						bind:value={contextArgsText}
						placeholder={ARG_PLACEHOLDERS[contextTool] ?? '{}'}
					/>
				</label>
			</div>
		{/if}

		<label class="form-control">
			<span class="label-text text-xs">Action on fire</span>
			<select class="select select-sm select-bordered w-full" bind:value={action}>
				{#each ACTIONS as a (a.value)}
					<option value={a.value}>{a.label}</option>
				{/each}
			</select>
		</label>

		{#if action === 'start_conversation'}
			<label class="form-control">
				<span class="label-text text-xs">Seeded prompt</span>
				<textarea
					class="textarea textarea-sm textarea-bordered w-full"
					rows="2"
					bind:value={prompt}
					required
					placeholder="CI is green. Review the diff and summarize what changed."
				></textarea>
			</label>
		{:else if action === 'run_automation'}
			<label class="form-control">
				<span class="label-text text-xs">Automation id</span>
				<input class="input input-sm input-bordered w-full font-mono text-xs" bind:value={automationId} required />
			</label>
		{:else}
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs">Headline (optional)</span>
					<input class="input input-sm input-bordered w-full" bind:value={title} />
				</label>
				{#if action === 'push'}
					<label class="form-control">
						<span class="label-text text-xs">Body (optional)</span>
						<input class="input input-sm input-bordered w-full" bind:value={body} />
					</label>
				{/if}
			</div>
		{/if}

		<div class="grid gap-2 sm:grid-cols-3">
			<label class="form-control">
				<span class="label-text text-xs">Check</span>
				<select class="select select-sm select-bordered w-full" bind:value={intervalSeconds}>
					{#each INTERVALS as i (i.value)}
						<option value={i.value}>{i.label}</option>
					{/each}
				</select>
			</label>
			<label class="form-control">
				<span class="label-text text-xs">Expires in (days)</span>
				<input
					class="input input-sm input-bordered w-full"
					type="number"
					min="1"
					max={MONITOR_MAX_DEADLINE_DAYS}
					bind:value={deadlineDays}
				/>
			</label>
			<label class="form-control">
				<span class="label-text text-xs">Max checks</span>
				<input class="input input-sm input-bordered w-full" type="number" min="1" max="2000" bind:value={maxChecks} />
			</label>
		</div>

		<label class="flex cursor-pointer items-center gap-2 text-xs">
			<input type="checkbox" class="toggle toggle-xs" bind:checked={oneShot} />
			<span>Retire after the first fire (one-shot)</span>
		</label>

		<div class="card-actions justify-end">
			<button class="btn btn-primary btn-sm" type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create monitor'}
			</button>
		</div>
	</div>
</form>
