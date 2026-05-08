<script lang="ts">
	import {
		analyzeMemoryReorganizationQuery,
		applyMemoryReorganizationCommand,
		type MemoryReorganizePlan,
		type MemoryReorganizeResult,
	} from '$lib/memory/memory.remote';

	let {
		open = $bindable(false),
		onApplied,
	}: {
		open?: boolean;
		onApplied?: () => void;
	} = $props();

	let plan = $state<MemoryReorganizePlan | null>(null);
	let result = $state<MemoryReorganizeResult | null>(null);
	let loading = $state(false);
	let applying = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open && !plan && !loading) {
			void load();
		}
		if (!open) {
			result = null;
			error = null;
		}
	});

	async function load(opts: { force?: boolean } = {}) {
		loading = true;
		error = null;
		try {
			if (opts.force) await analyzeMemoryReorganizationQuery().refresh();
			plan = (await analyzeMemoryReorganizationQuery()) as MemoryReorganizePlan;
		} catch (e) {
			error = (e as Error).message ?? 'Failed to analyze';
		} finally {
			loading = false;
		}
	}

	async function refresh() {
		plan = null;
		result = null;
		await load({ force: true });
	}

	async function apply() {
		if (applying || !plan) return;
		applying = true;
		error = null;
		try {
			result = (await applyMemoryReorganizationCommand()) as MemoryReorganizeResult;
			plan = null;
			onApplied?.();
		} catch (e) {
			error = (e as Error).message ?? 'Failed to apply';
		} finally {
			applying = false;
		}
	}

	function close() {
		open = false;
	}

	function reasonLabel(r: string): string {
		switch (r) {
			case 'alias-overlap':
				return 'shares an alias';
			case 'name-equal':
				return 'identical name';
			case 'name-contained':
				return 'name contained';
			default:
				return r;
		}
	}

	const totalProposed = $derived(
		(plan?.wingMerges.length ?? 0) + (plan?.closetMerges.length ?? 0) + (plan?.missingEmbeddings ?? 0),
	);
</script>

{#if open}
	<button class="reorganize__scrim" onclick={close} aria-label="Close" type="button"></button>
	<div class="reorganize" role="dialog" aria-label="Reorganize memory palace">
		<header class="reorganize__head">
			<div>
				<span class="reorganize__label">Reorganize / compact</span>
				<h2 class="reorganize__title">Preview proposed changes</h2>
			</div>
			<button class="console-iconbtn" onclick={close} aria-label="Close" title="Close">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path d="M18 6L6 18M6 6l12 12"/></svg>
			</button>
		</header>

		<div class="reorganize__body">
			{#if error}
				<div class="reorganize__error">{error}</div>
			{/if}

			{#if result}
				<section class="reorganize__section">
					<div class="reorganize__sec-head">
						<span class="reorganize__sec-label">Done</span>
					</div>
					<dl class="reorganize__result">
						<dt>Wings merged</dt><dd>{result.wingMergesApplied}</dd>
						<dt>Closets consolidated</dt><dd>{result.closetMergesApplied}</dd>
						<dt>Embeddings backfilled</dt><dd>{result.embeddingsBackfilled}</dd>
					</dl>
					{#if result.failures.length > 0}
						<div class="reorganize__failures">
							<span class="reorganize__failures-label">{result.failures.length} failure(s)</span>
							<ul>
								{#each result.failures as f, i (i)}<li>{f}</li>{/each}
							</ul>
						</div>
					{/if}
					<div class="reorganize__actions">
						<button class="btn btn-sm btn-primary" onclick={refresh}>Re-analyze</button>
						<button class="btn btn-sm btn-ghost" onclick={close}>Close</button>
					</div>
				</section>
			{:else if loading}
				<div class="reorganize__loading">
					<span class="loading loading-spinner loading-sm text-primary"></span>
					Analyzing palace…
				</div>
			{:else if plan}
				{#if totalProposed === 0}
					<div class="reorganize__empty">
						<div class="reorganize__empty-title">Already tidy</div>
						<div class="reorganize__empty-hint">No near-duplicate wings, no consolidatable closets, all drawers embedded. Nothing to change.</div>
						<div class="reorganize__actions">
							<button class="btn btn-sm btn-ghost" onclick={refresh}>Re-analyze</button>
							<button class="btn btn-sm btn-ghost" onclick={close}>Close</button>
						</div>
					</div>
				{:else}
					{#if plan.wingMerges.length > 0}
						<section class="reorganize__section">
							<div class="reorganize__sec-head">
								<span class="reorganize__sec-label">Wing merges · {plan.wingMerges.length}</span>
							</div>
							<ul class="reorganize__list">
								{#each plan.wingMerges as merge (merge.fromId + ':' + merge.toId)}
									<li class="reorganize__item">
										<div class="reorganize__merge">
											<span class="reorganize__merge-from">
												<span class="reorganize__kind is-{merge.fromKind}">{merge.fromKind}</span>
												{merge.fromName}
											</span>
											<span class="reorganize__arrow">→</span>
											<span class="reorganize__merge-to">
												<span class="reorganize__kind is-{merge.toKind}">{merge.toKind}</span>
												{merge.toName}
											</span>
										</div>
										<div class="reorganize__meta">
											<span class="reorganize__reason">{reasonLabel(merge.reason)}</span>
											{#if merge.movedRoomCount > 0}
												<span>· moves {merge.movedRoomCount} room{merge.movedRoomCount === 1 ? '' : 's'}</span>
											{/if}
											{#if merge.movedDrawerCount > 0}
												<span>· {merge.movedDrawerCount} drawer{merge.movedDrawerCount === 1 ? '' : 's'}</span>
											{/if}
										</div>
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					{#if plan.closetMerges.length > 0}
						<section class="reorganize__section">
							<div class="reorganize__sec-head">
								<span class="reorganize__sec-label">Closet consolidations · {plan.closetMerges.length}</span>
							</div>
							<ul class="reorganize__list">
								{#each plan.closetMerges as merge (merge.fromId + ':' + merge.toId)}
									<li class="reorganize__item">
										<div class="reorganize__merge">
											<span class="reorganize__merge-from">{merge.fromTopic}</span>
											<span class="reorganize__arrow">→</span>
											<span class="reorganize__merge-to">{merge.toTopic}</span>
										</div>
										<div class="reorganize__meta">
											<span>in {merge.wingName} › {merge.roomLabel}</span>
											{#if merge.movedDrawerCount > 0}
												<span>· {merge.movedDrawerCount} drawer{merge.movedDrawerCount === 1 ? '' : 's'}</span>
											{/if}
										</div>
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					{#if plan.missingEmbeddings > 0}
						<section class="reorganize__section">
							<div class="reorganize__sec-head">
								<span class="reorganize__sec-label">Embedding backfill</span>
							</div>
							<p class="reorganize__note">
								{plan.missingEmbeddings} drawer{plan.missingEmbeddings === 1 ? '' : 's'} missing an embedding vector.
								Up to 200 will be re-embedded per apply (run again to continue).
							</p>
						</section>
					{/if}

					<div class="reorganize__actions">
						<button class="btn btn-sm btn-primary" onclick={apply} disabled={applying}>
							{applying ? 'Applying…' : `Apply ${totalProposed} change${totalProposed === 1 ? '' : 's'}`}
						</button>
						<button class="btn btn-sm btn-ghost" onclick={refresh} disabled={applying}>Re-analyze</button>
						<button class="btn btn-sm btn-ghost" onclick={close} disabled={applying}>Cancel</button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.reorganize__scrim {
		position: fixed;
		inset: 0;
		background: color-mix(in oklab, var(--color-base-100) 70%, transparent);
		backdrop-filter: blur(2px);
		z-index: 30;
		border: 0;
		padding: 0;
		cursor: default;
	}

	.reorganize {
		position: fixed;
		top: calc(env(safe-area-inset-top, 0) + 80px);
		left: 50%;
		transform: translateX(-50%);
		width: min(720px, 92vw);
		max-height: min(80vh, 720px);
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 12px;
		box-shadow: 0 24px 48px color-mix(in oklab, var(--color-base-content) 25%, transparent);
		display: flex;
		flex-direction: column;
		z-index: 31;
		overflow: hidden;
		font-family: Consolas, 'Cascadia Code', monospace;
		font-size: 12px;
	}

	.reorganize__head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-base-300);
	}

	.reorganize__label {
		display: block;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-weight: 600;
	}

	.reorganize__title {
		margin: 2px 0 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--color-base-content);
	}

	.reorganize__body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.reorganize__error {
		padding: 10px 12px;
		border: 1px solid var(--color-error);
		border-radius: 6px;
		background: color-mix(in oklab, var(--color-error) 10%, transparent);
		color: var(--color-error);
		font-size: 11.5px;
	}

	.reorganize__loading {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 18px;
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
	}

	.reorganize__empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 36px 16px;
		text-align: center;
	}

	.reorganize__empty-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-primary);
	}

	.reorganize__empty-hint {
		font-size: 11.5px;
		color: color-mix(in oklab, var(--color-base-content) 55%, transparent);
		max-width: 340px;
	}

	.reorganize__section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.reorganize__sec-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.reorganize__sec-label {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
		font-weight: 600;
	}

	.reorganize__list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.reorganize__item {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px 10px;
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
		background: color-mix(in oklab, var(--color-base-content) 1.5%, var(--color-base-100));
	}

	.reorganize__merge {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}

	.reorganize__merge-from {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: color-mix(in oklab, var(--color-error) 90%, var(--color-base-content));
		text-decoration: line-through;
		text-decoration-color: color-mix(in oklab, var(--color-error) 50%, transparent);
	}

	.reorganize__merge-to {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--color-primary);
		font-weight: 600;
	}

	.reorganize__arrow {
		color: color-mix(in oklab, var(--color-base-content) 35%, transparent);
		font-weight: 700;
	}

	.reorganize__kind {
		font-size: 9px;
		padding: 1px 5px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		border: 1px solid currentColor;
	}

	.reorganize__kind.is-person { color: var(--color-primary); }
	.reorganize__kind.is-project { color: var(--color-secondary); }
	.reorganize__kind.is-topic { color: var(--color-accent); }
	.reorganize__kind.is-agent { color: var(--color-info); }

	.reorganize__meta {
		display: flex;
		gap: 4px;
		font-size: 10.5px;
		color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
	}

	.reorganize__reason {
		font-style: italic;
	}

	.reorganize__note {
		margin: 0;
		padding: 8px 10px;
		font-size: 11.5px;
		background: color-mix(in oklab, var(--color-base-content) 2%, var(--color-base-100));
		border: 1px solid var(--color-base-300);
		border-radius: 6px;
		color: color-mix(in oklab, var(--color-base-content) 75%, transparent);
		line-height: 1.5;
	}

	.reorganize__result {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 12px;
		margin: 0;
		padding: 10px 12px;
		background: color-mix(in oklab, var(--color-primary) 6%, var(--color-base-100));
		border: 1px solid color-mix(in oklab, var(--color-primary) 25%, var(--color-base-300));
		border-radius: 6px;
	}

	.reorganize__result dt {
		color: color-mix(in oklab, var(--color-base-content) 60%, transparent);
		font-size: 11px;
	}

	.reorganize__result dd {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-primary);
	}

	.reorganize__failures {
		padding: 8px 10px;
		border: 1px solid var(--color-warning);
		background: color-mix(in oklab, var(--color-warning) 8%, transparent);
		border-radius: 6px;
		margin-top: 8px;
	}

	.reorganize__failures-label {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 700;
		color: var(--color-warning);
	}

	.reorganize__failures ul {
		list-style: disc;
		padding-left: 16px;
		margin: 4px 0 0;
		font-size: 11px;
	}

	.reorganize__actions {
		display: flex;
		gap: 6px;
		margin-top: 4px;
	}
</style>
