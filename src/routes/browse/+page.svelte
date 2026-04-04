<script lang="ts">
	let url = $state('https://example.com')
	let screenshotSrc = $state<string | null>(null)
	let isLoading = $state(false)
	let errorMsg = $state<string | null>(null)
	let history = $state<Array<{ url: string; timestamp: string }>>([])
	let chatMessages = $state<Array<{ role: 'user' | 'assistant'; content: string }>>([])
	let chatInput = $state('')

	async function navigate() {
		if (!url.trim()) return
		isLoading = true
		errorMsg = null
		try {
			const res = await fetch('/api/browse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'navigate', url: url.trim() }),
			})
			const data = await res.json()
			if (!res.ok || data.error) {
				errorMsg = data.error ?? `Request failed (${res.status})`
				return
			}
			if (data.screenshot) {
				screenshotSrc = data.screenshot
			}
			history = [{ url: url.trim(), timestamp: new Date().toISOString() }, ...history.slice(0, 19)]
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Network error'
		} finally {
			isLoading = false
		}
	}

	async function refreshScreenshot() {
		isLoading = true
		errorMsg = null
		try {
			const res = await fetch('/api/browse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'screenshot' }),
			})
			const data = await res.json()
			if (!res.ok || data.error) {
				errorMsg = data.error ?? `Request failed (${res.status})`
				return
			}
			if (data.screenshot) {
				screenshotSrc = data.screenshot
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Network error'
		} finally {
			isLoading = false
		}
	}

	async function sendChat() {
		if (!chatInput.trim()) return
		const message = chatInput.trim()
		chatInput = ''
		chatMessages = [...chatMessages, { role: 'user', content: message }]

		// Simple agent-style chat — user provides navigation instructions
		if (message.toLowerCase().startsWith('go to ') || message.toLowerCase().startsWith('navigate to ')) {
			const targetUrl = message.replace(/^(go to|navigate to)\s+/i, '').trim()
			const finalUrl = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`
			url = finalUrl
			await navigate()
			chatMessages = [...chatMessages, { role: 'assistant', content: errorMsg ? `Failed: ${errorMsg}` : `Navigated to ${finalUrl}` }]
		} else if (message.toLowerCase() === 'screenshot' || message.toLowerCase() === 'refresh') {
			await refreshScreenshot()
			chatMessages = [...chatMessages, { role: 'assistant', content: errorMsg ? `Failed: ${errorMsg}` : 'Screenshot updated.' }]
		} else {
			chatMessages = [
				...chatMessages,
				{
					role: 'assistant',
					content: `Commands: "go to <url>" to navigate, "screenshot" to refresh the view.`,
				},
			]
		}
	}
</script>

<div class="flex h-[calc(100vh-4rem)] gap-4 p-4">
	<!-- Left: Chat Panel -->
	<div class="flex w-80 shrink-0 flex-col rounded-box bg-base-200 p-4">
		<h2 class="mb-3 text-lg font-bold">Browse Assistant</h2>

		<div class="flex grow flex-col gap-2 overflow-y-auto">
			{#each chatMessages as msg}
				<div class="chat {msg.role === 'user' ? 'chat-end' : 'chat-start'}">
					<div class="chat-bubble {msg.role === 'user' ? 'chat-bubble-primary' : 'chat-bubble-neutral'}">
						{msg.content}
					</div>
				</div>
			{/each}
		</div>

		<form class="mt-3 flex gap-2" onsubmit={(e) => { e.preventDefault(); sendChat() }}>
			<input
				type="text"
				class="input input-bordered grow input-sm"
				placeholder="Type a command..."
				bind:value={chatInput}
			/>
			<button type="submit" class="btn btn-primary btn-sm">Send</button>
		</form>
	</div>

	<!-- Right: Browser Viewport -->
	<div class="flex grow flex-col gap-3">
		<!-- URL Bar -->
		<form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); navigate() }}>
			<input
				type="text"
				class="input input-bordered grow"
				placeholder="Enter URL..."
				bind:value={url}
			/>
			<button type="submit" class="btn btn-primary" disabled={isLoading}>
				{#if isLoading}
					<span class="loading loading-spinner loading-sm"></span>
				{:else}
					Go
				{/if}
			</button>
			<button type="button" class="btn btn-ghost" onclick={refreshScreenshot} disabled={isLoading}>
				↻
			</button>
		</form>

		<!-- Viewport -->
		<div class="grow overflow-auto rounded-box border border-base-300 bg-base-100">
			{#if errorMsg}
				<div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
					<div class="badge badge-error badge-lg gap-2">Sandbox Unavailable</div>
					<p class="max-w-md text-sm text-base-content/60">{errorMsg}</p>
					<p class="text-xs text-base-content/40">Make sure the sandbox workspace is accessible and Chromium is available.</p>
				</div>
			{:else if screenshotSrc}
				<img
					src={screenshotSrc}
					alt="Browser viewport"
					class="w-full"
				/>
			{:else}
				<div class="flex h-full items-center justify-center text-base-content/40">
					<p>Enter a URL and click Go to start browsing</p>
				</div>
			{/if}
		</div>

		<!-- History -->
		{#if history.length > 0}
			<div class="flex gap-2 overflow-x-auto py-1">
				{#each history.slice(0, 5) as entry}
					<button
						class="badge badge-ghost badge-sm cursor-pointer truncate"
						onclick={() => { url = entry.url; navigate() }}
					>
						{entry.url.replace(/^https?:\/\//, '').slice(0, 30)}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
