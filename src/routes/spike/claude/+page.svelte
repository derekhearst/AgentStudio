<script lang="ts">
	/**
	 * Scratch page for the Claude Agent SDK spike.
	 *
	 * Success criteria, visible on screen:
	 *  1. text streams back  → the SDK ran on the CLI subscription, no API key
	 *  2. a `generate_image` tool_use appears → our in-process tool composed
	 */

	type Frame = Record<string, unknown> & { type?: string }

	let prompt = $state('Generate an image of a red bicycle in the rain, then describe it in one sentence.')
	let frames = $state<Frame[]>([])
	let running = $state(false)
	let errorText = $state('')

	const toolCalls = $derived(
		frames.flatMap((f) => {
			const msg = f.message as { content?: Array<Record<string, unknown>> } | undefined
			return (msg?.content ?? []).filter((b) => b?.type === 'tool_use')
		}),
	)

	const assistantText = $derived(
		frames
			.flatMap((f) => {
				const msg = f.message as { content?: Array<Record<string, unknown>> } | undefined
				return (msg?.content ?? []).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))
			})
			.join('\n'),
	)

	async function run() {
		running = true
		errorText = ''
		frames = []

		try {
			const response = await fetch('/spike/claude', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt }),
			})

			if (!response.ok || !response.body) {
				errorText = `HTTP ${response.status}: ${await response.text()}`
				return
			}

			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ''

			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				const chunks = buffer.split('\n\n')
				buffer = chunks.pop() ?? ''
				for (const chunk of chunks) {
					const line = chunk.replace(/^data: /, '').trim()
					if (!line) continue
					try {
						frames = [...frames, JSON.parse(line) as Frame]
					} catch {
						// partial frame; ignore
					}
				}
			}
		} catch (error) {
			errorText = error instanceof Error ? error.message : String(error)
		} finally {
			running = false
		}
	}
</script>

<div class="container mx-auto flex grow flex-col gap-4 p-4">
	<div>
		<h1 class="text-2xl font-bold">Claude Agent SDK spike</h1>
		<p class="text-base-content/70 text-sm">
			Runs on the Claude Code CLI login (no API key). Only the in-process
			<code class="badge badge-sm">generate_image</code> tool is allowed.
		</p>
	</div>

	<textarea class="textarea textarea-bordered h-24 w-full" bind:value={prompt} placeholder="Prompt"></textarea>

	<div class="flex items-center gap-2">
		<button class="btn btn-primary" onclick={run} disabled={running || !prompt.trim()}>
			{#if running}<span class="loading loading-spinner loading-sm"></span>{/if}
			Run
		</button>
		<span class="text-base-content/60 text-sm">{frames.length} frames</span>
	</div>

	{#if errorText}
		<div class="alert alert-error"><span>{errorText}</span></div>
	{/if}

	<div class="grid gap-4 md:grid-cols-2">
		<div class="card bg-base-200">
			<div class="card-body">
				<h2 class="card-title text-base">
					Tool calls
					{#if toolCalls.length > 0}<span class="badge badge-success">{toolCalls.length}</span>{/if}
				</h2>
				{#if toolCalls.length === 0}
					<p class="text-base-content/60 text-sm">None yet — this is the thing to watch.</p>
				{:else}
					{#each toolCalls as call (String(call.id))}
						<pre class="bg-base-300 overflow-x-auto rounded p-2 text-xs">{String(call.name)}
{JSON.stringify(call.input, null, 2)}</pre>
					{/each}
				{/if}
			</div>
		</div>

		<div class="card bg-base-200">
			<div class="card-body">
				<h2 class="card-title text-base">Assistant text</h2>
				<p class="whitespace-pre-wrap text-sm">{assistantText || '—'}</p>
			</div>
		</div>
	</div>

	<details class="collapse-arrow bg-base-200 collapse">
		<summary class="collapse-title text-sm font-medium">Raw frames</summary>
		<div class="collapse-content">
			<pre class="max-h-96 overflow-auto text-xs">{frames.map((f) => JSON.stringify(f)).join('\n')}</pre>
		</div>
	</details>
</div>
