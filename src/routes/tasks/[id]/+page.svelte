<svelte:head><title>{detail?.task.title ?? 'Task'} | DrokBot</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getAgentChoices, runTaskNow } from '$lib/agents';
	import { getTask, reassignTask, setTaskStatus, requestChanges, getTaskComments, getTaskMessages, addTaskMessage } from '$lib/tasks';
	import { approveChanges, getChangedFiles, getTaskDiff, rejectChanges, requestRevision } from '$lib/tasks';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const taskId = $derived(page.params.id ?? '');

	type TaskDetail = Awaited<ReturnType<typeof getTask>>;
	type AgentChoice = Awaited<ReturnType<typeof getAgentChoices>>[number];
	type ChangedFile = Awaited<ReturnType<typeof getChangedFiles>>['files'][number];
	type TaskComment = Awaited<ReturnType<typeof getTaskComments>>[number];
	type TaskMessage = Awaited<ReturnType<typeof getTaskMessages>>[number];

	let detail = $state<TaskDetail | null>(null);
	let agents = $state<AgentChoice[]>([]);
	let diff = $state('');
	let files = $state<ChangedFile[]>([]);
	let revisionFeedback = $state('');
	let selectedAgent = $state('');
	let busy = $state(false);
	let reviewError = $state<string | null>(null);

	// Phase B1: Changes Requested
	let changesComment = $state('');
	let comments = $state<TaskComment[]>([]);

	// Phase B2: Task Chat Thread
	let threadMessages = $state<TaskMessage[]>([]);
	let newThreadMessage = $state('');

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!taskId) return;
		const [taskDetail, agentRows, commentRows, messageRows] = await Promise.all([
			getTask(taskId),
			getAgentChoices(),
			getTaskComments(taskId),
			getTaskMessages(taskId),
		]);
		detail = taskDetail;
		agents = agentRows;
		comments = commentRows;
		threadMessages = messageRows;
		selectedAgent = taskDetail?.task.agentId ?? '';
		await loadReviewArtifacts();
	}

	async function loadReviewArtifacts() {
		if (!taskId) return;
		reviewError = null;
		try {
			const [diffData, filesData] = await Promise.all([getTaskDiff(taskId), getChangedFiles(taskId)]);
			diff = diffData.diff;
			files = filesData.files;
		} catch (cause) {
			reviewError = cause instanceof Error ? cause.message : 'No review data available';
			diff = '';
			files = [];
		}
	}

	async function runTask() {
		if (!taskId || busy) return;
		busy = true;
		try {
			await runTaskNow({ taskId });
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function setStatus(status: 'pending' | 'running' | 'review' | 'completed' | 'failed' | 'changes_requested') {
		if (!taskId) return;
		await setTaskStatus({ taskId, status });
		await refresh();
	}

	async function submitChangesRequest() {
		if (!taskId || !changesComment.trim()) return;
		await requestChanges({ taskId, comment: changesComment.trim() });
		changesComment = '';
		await refresh();
	}

	async function sendThreadMessage() {
		if (!taskId || !newThreadMessage.trim()) return;
		await addTaskMessage({ taskId, content: newThreadMessage.trim() });
		newThreadMessage = '';
		await refresh();
	}

	async function applyReassignment() {
		if (!taskId || !selectedAgent) return;
		await reassignTask({ taskId, agentId: selectedAgent });
		await refresh();
	}

	async function approve() {
		if (!taskId) return;
		await approveChanges(taskId);
		await refresh();
	}

	async function reject() {
		if (!taskId) return;
		await rejectChanges(taskId);
		await refresh();
	}

	async function askRevision() {
		if (!taskId || !revisionFeedback.trim()) return;
		await requestRevision({ taskId, feedback: revisionFeedback.trim() });
		revisionFeedback = '';
		await refresh();
	}
</script>

{#if !detail}
	<p class="text-sm text-base-content/70">Task not found.</p>
{:else}
	<section class="space-y-4">
		<a class="btn btn-sm btn-ghost" href="/tasks">Back to tasks</a>
		<ContentPanel>
			{#snippet header()}
				<div>
					<h1 class="text-2xl font-bold">{detail?.task.title}</h1>
					<p class="mt-1 text-sm text-base-content/70">{detail?.task.description}</p>
					<p class="mt-1 text-xs text-base-content/60">
						status {detail?.task.status} | priority {detail?.task.priority} | agent {detail?.agent?.name ?? 'unknown'}
						{#if detail?.task.reviewType}
							| review type <span class="badge badge-xs">{detail.task.reviewType}</span>
						{/if}
					</p>
				</div>
			{/snippet}
			<div class="flex flex-wrap gap-1">
				<button class="btn btn-xs" type="button" onclick={runTask} disabled={busy}>Run</button>
				<button class="btn btn-xs" type="button" onclick={() => setStatus('pending')}>Pending</button>
				<button class="btn btn-xs" type="button" onclick={() => setStatus('review')}>Review</button>
				<button class="btn btn-xs" type="button" onclick={() => setStatus('completed')}>Done</button>
				<button class="btn btn-xs btn-warning btn-outline" type="button" onclick={() => setStatus('changes_requested')}>Request Changes</button>
				<button class="btn btn-xs btn-error btn-outline" type="button" onclick={() => setStatus('failed')}>Fail</button>
			</div>
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Assignment</h2>{/snippet}
			<div class="flex flex-wrap gap-2">
				<select class="select select-bordered" bind:value={selectedAgent}>
					{#each agents as agent (agent.id)}
						<option value={agent.id}>{agent.name} ({agent.status})</option>
					{/each}
				</select>
				<button class="btn btn-outline" type="button" onclick={applyReassignment}>Reassign</button>
			</div>
		</ContentPanel>

		<section class="grid gap-4 xl:grid-cols-2">
			<ContentPanel>
				{#snippet header()}<h2 class="font-semibold">Changed Files</h2>{/snippet}
				{#if reviewError}
					<p class="mt-2 text-sm text-warning">{reviewError}</p>
				{:else if files.length === 0}
					<p class="mt-2 text-sm text-base-content/70">No files in review branch.</p>
				{:else}
					<ul class="mt-2 space-y-1 text-sm">
						{#each files as file (file.path)}
							<li class="rounded border border-base-300 bg-base-50 px-2 py-1">{file.status} {file.path}</li>
						{/each}
					</ul>
				{/if}
			</ContentPanel>

			<ContentPanel>
				{#snippet header()}<h2 class="font-semibold">Review Actions</h2>{/snippet}
				<div class="flex flex-wrap gap-2">
					<button class="btn btn-success btn-sm" type="button" onclick={approve}>Approve</button>
					<button class="btn btn-error btn-outline btn-sm" type="button" onclick={reject}>Reject</button>
				</div>
				<textarea
					class="textarea textarea-bordered mt-3 h-28 w-full"
					bind:value={revisionFeedback}
					placeholder="Request revision feedback"
				></textarea>
				<button class="btn btn-outline btn-sm mt-2" type="button" onclick={askRevision}>Request Revision</button>
			</ContentPanel>
		</section>

		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Diff</h2>{/snippet}
			<pre class="max-h-[420px] overflow-auto rounded border border-base-300 bg-base-50 p-3 text-xs">{diff || 'No diff available'}</pre>
		</ContentPanel>

		<!-- Changes Requested Comments -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Change Requests</h2>{/snippet}
			{#if comments.length === 0}
				<p class="text-sm text-base-content/70">No change requests yet.</p>
			{:else}
				<div class="space-y-2">
					{#each comments as comment (comment.id)}
						<div class="rounded-xl border border-base-300 bg-base-50 p-3 text-sm">
							<p class="text-xs text-base-content/55">{comment.role} · {new Date(comment.createdAt).toLocaleString()}</p>
							<p class="mt-1">{comment.content}</p>
						</div>
					{/each}
				</div>
			{/if}
			<div class="mt-3">
				<textarea
					class="textarea textarea-bordered h-20 w-full"
					bind:value={changesComment}
					placeholder="Describe changes needed..."
				></textarea>
				<button class="btn btn-warning btn-sm mt-2" type="button" onclick={submitChangesRequest} disabled={!changesComment.trim()}>
					Request Changes
				</button>
			</div>
		</ContentPanel>

		<!-- Task Chat Thread -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Task Thread</h2>{/snippet}
			{#if threadMessages.length === 0}
				<p class="text-sm text-base-content/70">No messages yet. Start a conversation about this task.</p>
			{:else}
				<div class="max-h-80 space-y-2 overflow-y-auto">
					{#each threadMessages as msg (msg.id)}
						<div class="flex gap-2" class:flex-row-reverse={msg.role === 'user'}>
							<div
								class="max-w-[80%] rounded-xl p-3 text-sm"
								class:bg-primary={msg.role === 'user'}
								class:text-primary-content={msg.role === 'user'}
								class:bg-base-200={msg.role !== 'user'}
							>
								<p>{msg.content}</p>
								<p class="mt-1 text-xs opacity-60">{new Date(msg.createdAt).toLocaleTimeString()}</p>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			<div class="mt-3 flex gap-2">
				<input
					class="input input-bordered flex-1"
					bind:value={newThreadMessage}
					placeholder="Message about this task..."
					onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadMessage(); } }}
				/>
				<button class="btn btn-primary btn-sm" type="button" onclick={sendThreadMessage} disabled={!newThreadMessage.trim()}>Send</button>
			</div>
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Execution Result</h2>{/snippet}
			{#if typeof detail.task.result === 'object' && detail.task.result}
				<pre class="max-h-[260px] overflow-auto rounded border border-base-300 bg-base-50 p-3 text-xs">{JSON.stringify(detail.task.result, null, 2)}</pre>
			{:else}
				<p class="text-sm text-base-content/70">No execution metadata yet.</p>
			{/if}
		</ContentPanel>
	</section>
{/if}

