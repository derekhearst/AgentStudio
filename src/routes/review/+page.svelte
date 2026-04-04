<svelte:head><title>Review | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listTasks, setTaskStatus, requestChanges } from '$lib/tasks/tasks.remote';
	import { approveChanges } from '$lib/tasks/review.remote';

	type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];

	let tasks = $state<TaskRow[]>([]);
	let currentIndex = $state(0);
	let busy = $state(false);
	let changesComment = $state('');
	let showCommentInput = $state(false);

	const current = $derived(tasks[currentIndex] ?? null);
	const remaining = $derived(tasks.length - currentIndex);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		const rows = await listTasks({ status: 'review', limit: 50 });
		tasks = rows;
		currentIndex = 0;
		showCommentInput = false;
		changesComment = '';
	}

	async function approve() {
		if (!current || busy) return;
		busy = true;
		try {
			await approveChanges(current.id);
			advance();
		} catch {
			// If no git branch, just mark completed
			await setTaskStatus({ taskId: current.id, status: 'completed' });
			advance();
		} finally {
			busy = false;
		}
	}

	async function reject() {
		if (!current || busy) return;
		if (!showCommentInput) {
			showCommentInput = true;
			return;
		}
		if (!changesComment.trim()) return;
		busy = true;
		try {
			await requestChanges({ taskId: current.id, comment: changesComment.trim() });
			changesComment = '';
			showCommentInput = false;
			advance();
		} finally {
			busy = false;
		}
	}

	function skip() {
		advance();
	}

	function advance() {
		if (currentIndex < tasks.length - 1) {
			currentIndex++;
			showCommentInput = false;
			changesComment = '';
		} else {
			void refresh();
		}
	}

	// Touch swipe handling
	let touchStartX = $state(0);
	let touchStartY = $state(0);
	let swiping = $state(false);
	let swipeOffset = $state(0);

	function handleTouchStart(e: TouchEvent) {
		touchStartX = e.touches[0].clientX;
		touchStartY = e.touches[0].clientY;
		swiping = true;
		swipeOffset = 0;
	}

	function handleTouchMove(e: TouchEvent) {
		if (!swiping) return;
		swipeOffset = e.touches[0].clientX - touchStartX;
	}

	async function handleTouchEnd() {
		if (!swiping) return;
		swiping = false;

		if (swipeOffset > 80) {
			await approve();
		} else if (swipeOffset < -80) {
			showCommentInput = true;
		}
		swipeOffset = 0;
	}
</script>

<section class="space-y-4">
	<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h1 class="text-3xl font-bold">Review Queue</h1>
				<p class="text-sm text-base-content/70">
					{remaining} task{remaining !== 1 ? 's' : ''} awaiting review
				</p>
			</div>
			<a class="btn btn-outline btn-sm" href="/tasks">Full Board</a>
		</div>
	</header>

	{#if !current}
		<div class="flex flex-col items-center gap-4 rounded-2xl border border-base-300 bg-base-100 p-12">
			<p class="text-lg font-semibold">All caught up!</p>
			<p class="text-sm text-base-content/70">No tasks awaiting review.</p>
			<button class="btn btn-outline" type="button" onclick={refresh}>Refresh</button>
		</div>
	{:else}
		<!-- Swipeable Card -->
		<div
			class="relative rounded-2xl border border-base-300 bg-base-100 p-6 transition-transform"
			style="transform: translateX({swipeOffset}px)"
			ontouchstart={handleTouchStart}
			ontouchmove={handleTouchMove}
			ontouchend={handleTouchEnd}
			role="article"
		>
			<!-- Swipe Hints -->
			{#if swipeOffset > 40}
				<div class="absolute inset-y-0 left-0 flex items-center px-4">
					<span class="badge badge-success badge-lg">Approve</span>
				</div>
			{/if}
			{#if swipeOffset < -40}
				<div class="absolute inset-y-0 right-0 flex items-center px-4">
					<span class="badge badge-warning badge-lg">Changes</span>
				</div>
			{/if}

			<div class="flex items-start justify-between gap-3">
				<div>
					<h2 class="text-xl font-bold">{current.title}</h2>
					<p class="mt-1 text-sm text-base-content/70">{current.agentName}</p>
				</div>
				<div class="flex items-center gap-2">
					<span class="badge badge-sm">p{current.priority}</span>
					{#if current.reviewType}
						<span class="badge badge-sm badge-outline">{current.reviewType}</span>
					{/if}
				</div>
			</div>

			<p class="mt-3 text-sm">{current.description}</p>

			{#if typeof current.result === 'object' && current.result && 'summary' in current.result}
				<div class="mt-4 rounded-xl border border-base-300 bg-base-50 p-3">
					<p class="text-xs font-semibold uppercase text-base-content/55">Result Summary</p>
					<p class="mt-1 text-sm">{String(current.result.summary)}</p>
				</div>
			{/if}

			<!-- Comment Input for Changes Requested -->
			{#if showCommentInput}
				<div class="mt-4">
					<textarea
						class="textarea textarea-bordered h-24 w-full"
						bind:value={changesComment}
						placeholder="Describe what needs to change..."
					></textarea>
				</div>
			{/if}

			<!-- Action Buttons -->
			<div class="mt-6 flex items-center justify-between gap-3">
				<button class="btn btn-warning flex-1" type="button" onclick={reject} disabled={busy}>
					{showCommentInput ? 'Submit' : 'Request Changes'}
				</button>
				<button class="btn btn-ghost" type="button" onclick={skip} disabled={busy}>Skip</button>
				<button class="btn btn-success flex-1" type="button" onclick={approve} disabled={busy}>Approve</button>
			</div>

			<div class="mt-3 text-center">
				<a class="link text-xs" href="/tasks/{current.id}">Open full detail</a>
			</div>
		</div>

		<!-- Queue Progress -->
		<div class="flex items-center gap-2">
			<progress class="progress progress-primary flex-1" value={currentIndex + 1} max={tasks.length}></progress>
			<span class="text-xs text-base-content/55">{currentIndex + 1} / {tasks.length}</span>
		</div>
	{/if}
</section>
