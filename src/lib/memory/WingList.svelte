<script lang="ts">
	import type { MemoryWingRow } from '$lib/memory/memory.remote';
	import { kindColor, wingInitials } from '$lib/memory/memory-map.layout';

	let {
		wings,
		selectedWingId = null,
		onSelect,
	}: {
		wings: MemoryWingRow[];
		selectedWingId?: string | null;
		onSelect?: (id: string) => void;
	} = $props();

	function relativeTime(d: string | Date | null): string {
		if (!d) return 'never';
		const date = typeof d === 'string' ? new Date(d) : d;
		const diff = Date.now() - date.getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
		if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
		return date.toISOString().slice(0, 10);
	}
</script>

<div class="wing-list">
	{#each wings as wing (wing.id)}
		{@const colors = kindColor((wing.kind ?? 'topic') as 'person' | 'project' | 'topic' | 'agent')}
		<button
			class="wing-list__item"
			class:is-selected={selectedWingId === wing.id}
			onclick={() => onSelect?.(wing.id)}
		>
			<div class="wing-list__avatar {colors.className}" style:background={colors.fill} style:border-color={colors.stroke} style:color={colors.text}>
				{wingInitials(wing.name)}
			</div>
			<div class="wing-list__main">
				<div class="wing-list__name-row">
					<span class="wing-list__name">{wing.name}</span>
					<span class="wing-list__kind {colors.className}">{wing.kind}</span>
				</div>
				{#if wing.summary}
					<div class="wing-list__summary">{wing.summary}</div>
				{:else if wing.aliases?.length}
					<div class="wing-list__aliases">aka {wing.aliases.join(', ')}</div>
				{/if}
				<div class="wing-list__meta">
					<span>{wing.drawerCount} drawers</span>
					<span>·</span>
					<span>{wing.roomCount} rooms</span>
					<span>·</span>
					<span>{relativeTime(wing.lastTouchedAt)}</span>
				</div>
			</div>
		</button>
	{:else}
		<div class="wing-list__empty">No wings yet — chat to seed memories.</div>
	{/each}
</div>

<style>
	.wing-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		font-family: Consolas, 'Cascadia Code', monospace;
	}

	.wing-list__item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		border-radius: 8px;
		border: 1px solid var(--color-base-300);
		background: var(--color-base-100);
		text-align: left;
		font: inherit;
		cursor: pointer;
		color: var(--color-base-content);
		transition: border-color 120ms;
	}

	.wing-list__item:hover {
		border-color: color-mix(in oklab, var(--color-primary) 30%, var(--color-base-300));
	}

	.wing-list__item.is-selected {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-primary) 35%, transparent);
	}

	.wing-list__avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border-radius: 9px;
		border: 1.5px solid;
		font-size: 13px;
		font-weight: 700;
		flex: 0 0 auto;
	}

	.wing-list__main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.wing-list__name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.wing-list__name {
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wing-list__kind {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 1px 5px;
		border-radius: 3px;
		border: 1px solid currentColor;
		flex: 0 0 auto;
	}

	.wing-list__kind.is-person { color: var(--color-primary); }
	.wing-list__kind.is-project { color: var(--color-secondary); }
	.wing-list__kind.is-topic { color: var(--color-accent); }
	.wing-list__kind.is-agent { color: var(--color-info); }

	.wing-list__summary {
		font-size: 11px;
		line-height: 1.4;
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.wing-list__aliases {
		font-size: 10.5px;
		font-style: italic;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.wing-list__meta {
		display: flex;
		gap: 4px;
		font-size: 10px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.wing-list__empty {
		padding: 24px;
		text-align: center;
		font-style: italic;
		color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
		font-size: 12px;
	}
</style>
