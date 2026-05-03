<svelte:head><title>{detail?.run.label ?? 'Run'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getRunDetailQuery } from '$lib/runs/runs.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const runId = $derived(page.params.id ?? '');

	type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetailQuery>>>;

	let detail = $state<RunDetail | null>(null);
	let loading = $state(true);
	let includeNoisy = $state(false);
	let error = $state<string | null>(null);

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			detail = await getRunDetailQuery({ runId, includeNoisyEvents: includeNoisy });
			if (!detail) error = 'Run not found';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	function stateTone(s: string): string {
		switch (s) {
			case 'queued':
				return 'badge-ghost';
			case 'running':
				return 'badge-primary';
			case 'waiting_tool_approval':
				return 'badge-warning';
			case 'waiting_user_input':
				return 'badge-warning';
			case 'waiting_plan_decision':
				return 'badge-warning';
			case 'completed':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'canceled':
				return 'badge-ghost';
			default:
				return 'badge-ghost';
		}
	}

	function eventTone(t: string): string {
		if (t === 'tool_pending') return 'badge-warning';
		if (t === 'tool_call' || t === 'subagent_tool_call') return 'badge-info';
		if (t === 'tool_result' || t === 'subagent_tool_result') return 'badge-success';
		if (t === 'tool_denied' || t === 'subagent_tool_denied') return 'badge-error';
		if (t === 'ask_user') return 'badge-warning';
		if (t === 'compaction') return 'badge-warning';
		if (t === 'context_stats') return 'badge-info';
		if (t === 'metrics') return 'badge-info';
		if (t === 'done') return 'badge-success';
		if (t === 'subagent_start' || t === 'subagent_done') return 'badge-secondary';
		if (t === 'subagent_delta' || t === 'delta' || t === 'reasoning') return 'badge-ghost';
		return 'badge-ghost';
	}

	function fmtDate(iso: Date | string | null | undefined) {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function previewPayload(payload: unknown): string {
		if (payload === null || payload === undefined) return '';
		if (typeof payload === 'string') return payload.slice(0, 240);
		try {
			return JSON.stringify(payload).slice(0, 240);
		} catch {
			return '(unserializable)';
		}
	}
</script>

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center">
		<p class="text-sm text-base-content/55">{error ?? 'Run not found.'}</p>
	</div>
{:else}
	{@const r = detail.run}
	<section class="space-y-4">
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/chat/{r.conversationId}">← Back to chat</a>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<h1 class="text-lg font-bold leading-tight sm:text-xl">{r.label ?? '(unnamed run)'}</h1>
							<span class="badge badge-sm {stateTone(r.state)}">{r.state}</span>
							<span class="badge badge-sm badge-outline">{r.source}</span>
						</div>
						<p class="mt-1 font-mono text-xs text-base-content/55">{r.id}</p>
						<p class="mt-0.5 text-xs text-base-content/55">
							Started {fmtDate(r.startedAt)}{r.finishedAt ? ` · Finished ${fmtDate(r.finishedAt)}` : ''}
						</p>
					</div>
				</div>
			{/snippet}

			<div class="grid gap-2 text-sm sm:grid-cols-2">
				{#if detail.conversation}
					<div>
						<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Conversation</p>
						<a href="/chat/{detail.conversation.id}" class="link link-hover">{detail.conversation.title}</a>
					</div>
				{/if}
				{#if detail.agent}
					<div>
						<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Agent</p>
						<a href="/agents/{detail.agent.id}" class="link link-hover">{detail.agent.name}</a>
						<p class="text-xs text-base-content/55">{detail.agent.role}</p>
					</div>
				{/if}
				{#if detail.task}
					<div>
						<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Task</p>
						<a href="/tasks/{detail.task.id}" class="link link-hover">{detail.task.title}</a>
						<span class="badge badge-xs ml-1 {stateTone(detail.task.status)}">{detail.task.status}</span>
					</div>
				{/if}
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide text-base-content/45">Round</p>
					<p class="font-mono">{r.currentRound}</p>
				</div>
			</div>

			{#if r.error}
				<div class="alert alert-error mt-3 py-2 text-xs">
					<span class="font-semibold uppercase tracking-wide">Error:</span>
					<span class="font-mono">{r.error}</span>
				</div>
			{/if}
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Event timeline</h2>
						<span class="badge badge-sm badge-ghost">
							{detail?.events.length ?? 0}{(detail?.filteredOutCount ?? 0) > 0 ? ` (+${detail?.filteredOutCount} hidden)` : ''}
						</span>
					</div>
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input
							type="checkbox"
							class="toggle toggle-xs"
							checked={includeNoisy}
							onchange={(e) => {
								includeNoisy = (e.currentTarget as HTMLInputElement).checked;
								void load();
							}}
						/>
						<span>Include delta / reasoning</span>
					</label>
				</div>
			{/snippet}

			{#if detail.events.length === 0}
				<p class="py-8 text-center text-sm italic text-base-content/45">No events recorded.</p>
			{:else}
				<ol class="space-y-1.5 text-sm">
					{#each detail.events as evt (evt.id)}
						<li class="flex items-start gap-2 rounded-xl border border-base-300/60 bg-base-100 px-3 py-2">
							<span class="font-mono text-xs text-base-content/55 tabular-nums shrink-0 w-12">#{evt.seq}</span>
							<span class="badge badge-xs {eventTone(evt.type)} shrink-0">{evt.type}</span>
							<span class="line-clamp-2 min-w-0 flex-1 font-mono text-[11px] leading-snug text-base-content/70 break-all">
								{previewPayload(evt.payload)}
							</span>
							<span class="font-mono text-[10px] text-base-content/40 shrink-0">{fmtDate(evt.createdAt)}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</ContentPanel>
	</section>
{/if}
