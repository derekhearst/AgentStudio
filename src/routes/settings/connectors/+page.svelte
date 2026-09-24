<svelte:head><title>Connectors | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		deleteMcpServerCommand,
		listMcpServersQuery,
		setMcpServerEnabledCommand,
		setMcpToolPoliciesCommand,
		testMcpServerCommand
	} from '$lib/mcp/mcp.remote';
	import { MCP_TRANSPORT_LABELS, type McpToolPolicy } from '$lib/mcp/mcp-config';
	import McpServerForm from '$lib/mcp/McpServerForm.svelte';
	import McpToolPolicyList from '$lib/mcp/McpToolPolicyList.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { confirmDialog } from '$lib/ui/confirm-dialog.svelte';
	import { fetchFresh } from '$lib/ui/fresh-query';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	/**
	 * Settings → Connectors (#17): the remote MCP servers chats can use.
	 *
	 * Add, test, enable, disable and remove a server, and decide per tool whether it runs without
	 * asking, asks every time, or is refused. See docs/mcp/mcp.md.
	 */

	type Result = Awaited<ReturnType<typeof listMcpServersQuery>>;
	type Connector = Result['servers'][number];

	let connectors = $state<Connector[]>([]);
	let encryptionConfigured = $state(true);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	/** 'new', a connector's id while it is being edited, or null. */
	let formFor = $state<string | null>(null);

	const editing = $derived(formFor && formFor !== 'new' ? (connectors.find((c) => c.id === formFor) ?? null) : null);
	const enabledCount = $derived(connectors.filter((c) => c.enabled).length);

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			const result = await fetchFresh(listMcpServersQuery());
			connectors = result.servers;
			encryptionConfigured = result.encryptionConfigured;
			error = null;
		} catch (err) {
			error = remoteErrorMessage(err, 'Could not load connectors.');
		} finally {
			loading = false;
		}
	}

	function replace(updated: Connector) {
		connectors = connectors.some((c) => c.id === updated.id)
			? connectors.map((c) => (c.id === updated.id ? updated : c))
			: [...connectors, updated];
	}

	async function withBusy(id: string, run: () => Promise<string | null>) {
		busyId = id;
		error = null;
		notice = null;
		try {
			notice = await run();
		} catch (err) {
			error = remoteErrorMessage(err, 'That did not work.');
		} finally {
			busyId = null;
		}
	}

	function test(connector: { id: string; label: string }) {
		void withBusy(connector.id, async () => {
			const { server, result } = await testMcpServerCommand({ id: connector.id });
			replace(server);
			if (!result.ok) {
				error = `${connector.label}: ${result.error}`;
				return null;
			}
			const count = result.tools.length;
			return `${connector.label} connected — ${count} ${count === 1 ? 'tool' : 'tools'}.`;
		});
	}

	function toggle(connector: Connector) {
		const enabled = !connector.enabled;
		void withBusy(connector.id, async () => {
			replace(await setMcpServerEnabledCommand({ id: connector.id, enabled }));
			return enabled
				? `${connector.label} is on for the next chat turn.`
				: `${connector.label} is off; chats no longer load it.`;
		});
	}

	function setPolicies(connector: Connector, policies: Record<string, McpToolPolicy>) {
		void withBusy(connector.id, async () => {
			replace(await setMcpToolPoliciesCommand({ id: connector.id, policies }));
			return null;
		});
	}

	async function remove(connector: Connector) {
		const ok = await confirmDialog({
			title: `Remove ${connector.label}?`,
			message: 'Chats stop loading its tools, and its stored token and headers are deleted.',
			confirmLabel: 'Remove',
			variant: 'danger'
		});
		if (!ok) return;
		void withBusy(connector.id, async () => {
			await deleteMcpServerCommand({ id: connector.id });
			connectors = connectors.filter((c) => c.id !== connector.id);
			if (formFor === connector.id) formFor = null;
			return `Removed ${connector.label}.`;
		});
	}

	async function handleSaved(saved: { id: string; label: string }, testNow: boolean) {
		formFor = null;
		await load();
		notice = `Saved ${saved.label}.`;
		if (testNow) test(saved);
	}

	function lastTest(connector: Connector): { tone: string; text: string } {
		if (connector.lastTestOk === null || !connector.lastTestedAt) {
			return { tone: 'opacity-60', text: 'Not tested since it was last changed.' };
		}
		const when = new Date(connector.lastTestedAt).toLocaleString();
		if (connector.lastTestOk) {
			const count = connector.tools.length;
			return { tone: 'text-success', text: `Connected — ${count} ${count === 1 ? 'tool' : 'tools'} · tested ${when}` };
		}
		return { tone: 'text-error', text: `${connector.lastError ?? 'The last test failed.'} · tested ${when}` };
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Connectors"
		crumbs={[{ label: 'Settings', href: '/settings' }]}
		backHref="/settings"
		subtitle="Remote MCP servers your chats can use"
	>
		{#snippet chips()}
			<span class="console-chip">{enabledCount} on</span>
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-ghost btn-xs" type="button" onclick={() => void load()} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
			<button class="btn btn-primary btn-xs" type="button" onclick={() => (formFor = 'new')} disabled={formFor === 'new'}>
				Add connector
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">
		{#if error}
			<div role="alert" class="alert alert-error py-2 text-sm break-words">{error}</div>
		{/if}
		{#if notice}
			<div role="status" class="alert alert-success py-2 text-sm">{notice}</div>
		{/if}
		{#if !encryptionConfigured}
			<div role="alert" class="alert alert-warning py-2 text-sm">
				APP_ENCRYPTION_KEY is not set on this server, so connectors that need a token or header cannot be saved.
			</div>
		{/if}

		<ContentPanel compact>
			<div class="space-y-1.5 text-xs leading-relaxed opacity-75">
				<p>
					A connector's tools join chats whose agent has no fixed tool list. Each tool asks for your approval every
					time until you set it to <strong>Allow</strong> (runs without asking in the Ask and Accept-edits modes) or
					<strong>Block</strong> (refused in every mode). Plan mode refuses connector tools; Bypass runs every tool that is
					not blocked.
				</p>
				<p>
					Remote servers only, over Streamable HTTP or SSE, with a bearer token or headers for sign-in. Servers that need
					an OAuth sign-in, and local (stdio) servers, are not supported yet.
				</p>
			</div>
		</ContentPanel>

		{#if formFor === 'new'}
			<McpServerForm
				{encryptionConfigured}
				onSaved={(saved, testNow) => void handleSaved(saved, testNow)}
				onCancel={() => (formFor = null)}
			/>
		{/if}

		{#if loading && connectors.length === 0}
			<div class="flex justify-center py-16">
				<span class="loading loading-spinner loading-lg text-primary"></span>
			</div>
		{:else if connectors.length === 0 && formFor !== 'new'}
			<div class="rounded-2xl border border-dashed border-base-300 bg-base-100/80 px-4 py-12 text-center">
				<p class="text-base font-medium">No connectors yet</p>
				<p class="mt-1 text-sm opacity-55">Add a remote MCP server to give your chats its tools.</p>
			</div>
		{/if}

		{#each connectors as connector (connector.id)}
			{@const status = lastTest(connector)}
			{@const busy = busyId === connector.id}
			{#if formFor === connector.id && editing}
				{#key connector.id}
					<McpServerForm
						server={editing}
						{encryptionConfigured}
						onSaved={(saved, testNow) => void handleSaved(saved, testNow)}
						onCancel={() => (formFor = null)}
					/>
				{/key}
			{:else}
				<section
					class="card border-base-300 bg-base-100 rounded-2xl border"
					aria-label={`Connector ${connector.label}`}
				>
					<div class="card-body gap-3 p-3 sm:p-4">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="min-w-0 flex-1 basis-48">
								<div class="flex flex-wrap items-center gap-2">
									<h2 class="text-sm font-semibold break-words">{connector.label}</h2>
									<span class="badge badge-ghost badge-sm">{MCP_TRANSPORT_LABELS[connector.transport]}</span>
									{#if !connector.enabled}
										<span class="badge badge-sm">Off</span>
									{/if}
								</div>
								<p class="mt-0.5 font-mono text-[11px] break-all opacity-60">mcp__{connector.name}__…</p>
								<p class="font-mono text-[11px] break-all opacity-60">{connector.url}</p>
								{#if connector.hasBearerToken || connector.headerNames.length > 0}
									<p class="text-[11px] break-words opacity-60">
										Signs in with
										{[connector.hasBearerToken ? 'a bearer token' : null, ...connector.headerNames]
											.filter(Boolean)
											.join(', ')}
									</p>
								{/if}
							</div>
							<label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
								<input
									type="checkbox"
									class="toggle toggle-success toggle-sm"
									checked={connector.enabled}
									disabled={busy}
									onchange={() => toggle(connector)}
									aria-label={`Use ${connector.label} in chats`}
								/>
								<span>{connector.enabled ? 'On' : 'Off'}</span>
							</label>
						</div>

						<p class="text-xs break-words {status.tone}">{status.text}</p>

						<div class="flex flex-wrap gap-2">
							<button type="button" class="btn btn-xs" disabled={busy} onclick={() => test(connector)}>
								{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
								Test
							</button>
							<button type="button" class="btn btn-ghost btn-xs" disabled={busy} onclick={() => (formFor = connector.id)}>
								Edit
							</button>
							<button type="button" class="btn btn-ghost btn-xs text-error" disabled={busy} onclick={() => void remove(connector)}>
								Remove
							</button>
						</div>

						{#if connector.tools.length > 0}
							<details class="rounded-xl border border-base-300/60 px-3 py-2">
								<summary class="cursor-pointer text-xs font-medium">
									Tools ({connector.tools.length}) — what each may do
								</summary>
								<div class="mt-2">
									<McpToolPolicyList
										connectorLabel={connector.label}
										tools={connector.tools}
										policies={connector.toolPolicies}
										{busy}
										onChange={(next) => setPolicies(connector, next)}
									/>
								</div>
							</details>
						{:else}
							<p class="text-xs opacity-55">Test the connection to list its tools and set what each may do.</p>
						{/if}
					</div>
				</section>
			{/if}
		{/each}
	</div>
</div>
