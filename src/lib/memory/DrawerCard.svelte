<script lang="ts">
	import type { MemoryDrawerRow, MemoryDrawerAaak } from '$lib/memory/memory.remote';

	let {
		drawer,
		selected = false,
		onSelect,
	}: {
		drawer: MemoryDrawerRow;
		selected?: boolean;
		onSelect?: (id: string) => void;
	} = $props();

	const aaak = $derived(drawer.aaak as MemoryDrawerAaak | null);
	const tagCount = $derived.by(() => {
		if (!aaak?.tags) return 0;
		const t = aaak.tags;
		return (t.p?.length ?? 0) + (t.l?.length ?? 0) + (t.e?.length ?? 0) + (t.i?.length ?? 0) + (t.t?.length ?? 0);
	});

	function formatTime(d: string | Date): string {
		const date = typeof d === 'string' ? new Date(d) : d;
		const now = new Date();
		const sameDay = date.toDateString() === now.toDateString();
		if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

<button
	type="button"
	class="drawer-card role-{drawer.role}"
	class:is-selected={selected}
	onclick={() => onSelect?.(drawer.id)}
>
	<div class="drawer-card__head">
		<span class="drawer-card__role">{drawer.role}</span>
		<span class="drawer-card__tokens">{drawer.tokenCount} tok</span>
		<span class="drawer-card__time">{formatTime(drawer.occurredAt)}</span>
	</div>
	<div class="drawer-card__content">{drawer.content}</div>
	<div class="drawer-card__foot">
		{#if tagCount > 0}
			<span class="drawer-card__chip" title="AAAK tags extracted from this memory">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/></svg>
				{tagCount}
			</span>
		{/if}
		{#if drawer.sourceMessageId}
			<span class="drawer-card__chip" title="Linked to a chat message">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
			</span>
		{/if}
		{#if drawer.linkedArtifactId}
			<span class="drawer-card__chip" title="Linked artifact">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
			</span>
		{/if}
	</div>
</button>

<style>
	.drawer-card {
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--color-base-300);
		background: var(--color-base-100);
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
		color: var(--color-base-content);
		cursor: pointer;
		width: 100%;
		transition: border-color 120ms, background 120ms, transform 80ms;
	}

	.drawer-card:hover {
		border-color: color-mix(in oklab, var(--color-primary) 35%, var(--color-base-300));
	}

	.drawer-card:active {
		transform: scale(0.997);
	}

	.drawer-card.is-selected {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-primary) 40%, transparent);
	}

	.drawer-card.role-user {
		border-left: 3px solid var(--color-primary);
	}

	.drawer-card.role-assistant {
		border-left: 3px solid var(--color-secondary);
	}

	.drawer-card.role-system {
		border-left: 3px solid var(--color-accent);
	}

	.drawer-card.role-note {
		border-left: 3px solid color-mix(in oklab, var(--color-base-content) 30%, transparent);
		background: color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
	}

	.drawer-card__head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.drawer-card__role {
		font-weight: 700;
		color: color-mix(in oklab, var(--color-base-content) 80%, transparent);
	}

	.drawer-card.role-user .drawer-card__role { color: var(--color-primary); }
	.drawer-card.role-assistant .drawer-card__role { color: var(--color-secondary); }
	.drawer-card.role-system .drawer-card__role { color: var(--color-accent); }

	.drawer-card__tokens {
		opacity: 0.75;
	}

	.drawer-card__time {
		margin-left: auto;
		opacity: 0.75;
	}

	.drawer-card__content {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		white-space: pre-wrap;
		line-height: 1.45;
		color: color-mix(in oklab, var(--color-base-content) 90%, transparent);
	}

	.drawer-card__foot {
		display: flex;
		gap: 4px;
		margin-top: 2px;
	}

	.drawer-card__chip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 1px 5px;
		border-radius: 999px;
		border: 1px solid var(--color-base-300);
		background: var(--color-base-200);
		font-size: 9.5px;
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
	}
</style>
