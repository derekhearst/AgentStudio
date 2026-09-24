<script lang="ts">
	import { untrack } from 'svelte';
	import {
		CONNECTOR_NAME_MAX_LENGTH,
		MAX_CONNECTOR_HEADERS,
		MCP_TRANSPORTS,
		MCP_TRANSPORT_LABELS,
		connectorNameProblem,
		suggestConnectorName,
		type McpTransport
	} from '$lib/mcp/mcp-config';
	import { createMcpServerCommand, updateMcpServerCommand } from '$lib/mcp/mcp.remote';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	/**
	 * Add or edit a connector (#17).
	 *
	 * The form never holds a stored secret: the page is only told which headers are set and
	 * whether a bearer token is. So on an edit a blank token or header value means "keep what is
	 * stored", and removing one is an explicit action. The name is fixed once the connector
	 * exists — it is the prefix of every tool the server provides.
	 */

	type ServerFields = {
		id: string;
		name: string;
		label: string;
		transport: McpTransport;
		url: string;
		timeoutMs: number | null;
		headerNames: string[];
		hasBearerToken: boolean;
	};

	type HeaderRow = { key: number; name: string; value: string; stored: boolean; remove: boolean };

	let {
		server = null,
		encryptionConfigured,
		onSaved,
		onCancel
	}: {
		server?: ServerFields | null;
		encryptionConfigured: boolean;
		onSaved: (saved: { id: string; label: string }, testNow: boolean) => void;
		onCancel: () => void;
	} = $props();

	// The form edits a copy. The page re-mounts it (`{#key}`) to edit a different connector.
	const initial = untrack(() => server);
	const editing = initial !== null;

	let label = $state(initial?.label ?? '');
	let nameInput = $state(initial?.name ?? '');
	let nameTouched = $state(editing);
	let transport = $state<McpTransport>(initial?.transport ?? 'http');
	let url = $state(initial?.url ?? '');
	let timeoutText = $state(initial?.timeoutMs ? String(initial.timeoutMs / 1000) : '');
	let bearerToken = $state('');
	let removeBearer = $state(false);
	let nextKey = 0;
	let headerRows = $state<HeaderRow[]>(
		(initial?.headerNames ?? []).map((name) => ({ key: nextKey++, name, value: '', stored: true, remove: false }))
	);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Until the name is edited by hand it follows the label.
	const name = $derived(nameTouched ? nameInput : suggestConnectorName(label));
	const nameProblem = $derived(editing || !name ? null : connectorNameProblem(name));
	const liveHeaders = $derived(headerRows.filter((row) => !row.remove).length);
	const cleartext = $derived(/^http:\/\//i.test(url.trim()));
	const needsKey = $derived(
		!encryptionConfigured && (bearerToken.trim() !== '' || headerRows.some((row) => !row.stored && row.name.trim()))
	);

	function addHeader() {
		headerRows = [...headerRows, { key: nextKey++, name: '', value: '', stored: false, remove: false }];
	}

	function dropHeader(row: HeaderRow) {
		if (row.stored) {
			headerRows = headerRows.map((r) => (r.key === row.key ? { ...r, remove: !r.remove, value: '' } : r));
		} else {
			headerRows = headerRows.filter((r) => r.key !== row.key);
		}
	}

	function timeoutMs(): number | null {
		const text = timeoutText.trim();
		if (!text) return null;
		const seconds = Number(text);
		if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('The call timeout is a number of seconds.');
		return Math.round(seconds * 1000);
	}

	function newHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		for (const row of headerRows) {
			if (row.stored) continue;
			const headerName = row.name.trim();
			if (!headerName && !row.value) continue;
			if (!headerName) throw new Error('Every header needs a name.');
			if (!row.value) throw new Error(`Enter a value for the "${headerName}" header.`);
			headers[headerName] = row.value;
		}
		return headers;
	}

	async function save(testNow: boolean) {
		if (busy) return;
		error = null;
		busy = true;
		try {
			if (initial) {
				const headers: Record<string, string | null> = { ...newHeaders() };
				for (const row of headerRows) {
					if (!row.stored) continue;
					if (row.remove) headers[row.name] = null;
					else if (row.value) headers[row.name] = row.value;
				}
				const saved = await updateMcpServerCommand({
					id: initial.id,
					label,
					transport,
					url,
					timeoutMs: timeoutMs(),
					// Blank keeps the stored token; null removes it.
					bearerToken: removeBearer ? null : bearerToken,
					headers
				});
				onSaved(saved, testNow);
			} else {
				const saved = await createMcpServerCommand({
					label,
					name,
					transport,
					url,
					timeoutMs: timeoutMs(),
					bearerToken: bearerToken.trim() ? bearerToken.trim() : null,
					headers: newHeaders()
				});
				onSaved(saved, testNow);
			}
		} catch (err) {
			error = remoteErrorMessage(err, 'Could not save the connector.');
		} finally {
			busy = false;
		}
	}
</script>

<form
	class="card border-base-300 bg-base-100 rounded-2xl border"
	aria-label={editing ? `Edit connector ${initial?.label}` : 'New connector'}
	onsubmit={(event) => {
		event.preventDefault();
		void save(false);
	}}
>
	<div class="card-body gap-3 p-3 sm:p-4">
		<div>
			<h2 class="text-sm font-semibold">{editing ? `Edit ${initial?.label}` : 'New connector'}</h2>
			<p class="text-xs opacity-60">A remote MCP server over Streamable HTTP or SSE. Tokens and header values are stored encrypted and never shown again.</p>
		</div>

		{#if error}
			<div role="alert" class="alert alert-error py-2 text-xs">{error}</div>
		{/if}

		<div class="grid gap-3 sm:grid-cols-2">
			<label class="form-control">
				<span class="label-text text-xs">Label</span>
				<input
					class="input input-sm input-bordered w-full"
					bind:value={label}
					required
					maxlength="80"
					placeholder="GitHub"
					aria-label="Label"
				/>
			</label>
			<label class="form-control">
				<span class="label-text text-xs">Name</span>
				<input
					class="input input-sm input-bordered w-full font-mono"
					value={name}
					oninput={(event) => {
						nameTouched = true;
						nameInput = event.currentTarget.value;
					}}
					disabled={editing}
					required
					maxlength={CONNECTOR_NAME_MAX_LENGTH}
					placeholder="github"
					aria-label="Name"
				/>
				<span class="mt-1 break-all text-[11px] opacity-55">
					{#if nameProblem}
						<span class="text-error">{nameProblem}</span>
					{:else}
						Tools appear as <code>mcp__{name || 'name'}__…</code>{editing ? '. Fixed once created.' : ''}
					{/if}
				</span>
			</label>
		</div>

		<div class="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
			<label class="form-control">
				<span class="label-text text-xs">Transport</span>
				<select class="select select-sm select-bordered w-full" bind:value={transport} aria-label="Transport">
					{#each MCP_TRANSPORTS as option (option)}
						<option value={option}>{MCP_TRANSPORT_LABELS[option]}</option>
					{/each}
				</select>
			</label>
			<label class="form-control min-w-0">
				<span class="label-text text-xs">URL</span>
				<input
					class="input input-sm input-bordered w-full font-mono text-xs"
					type="url"
					bind:value={url}
					required
					placeholder={transport === 'http' ? 'https://example.com/mcp' : 'https://example.com/sse'}
					aria-label="URL"
				/>
				{#if cleartext}
					<span class="mt-1 text-[11px] text-warning">Plain http: a token or header would travel unencrypted.</span>
				{/if}
			</label>
		</div>

		<label class="form-control">
			<span class="label-text text-xs">Bearer token</span>
			<input
				class="input input-sm input-bordered w-full font-mono text-xs"
				type="password"
				autocomplete="off"
				bind:value={bearerToken}
				disabled={removeBearer}
				placeholder={initial?.hasBearerToken ? 'Set — leave blank to keep it' : 'Optional — sent as Authorization: Bearer …'}
				aria-label="Bearer token"
			/>
			{#if initial?.hasBearerToken}
				<span class="mt-1 flex items-center gap-1.5 text-[11px]">
					<input type="checkbox" class="checkbox checkbox-xs" bind:checked={removeBearer} aria-label="Remove the stored token" />
					Remove the stored token
				</span>
			{/if}
		</label>

		<fieldset class="space-y-2">
			<legend class="label-text text-xs">Headers</legend>
			{#each headerRows as row (row.key)}
				<div class="flex flex-wrap items-center gap-2">
					<input
						class="input input-sm input-bordered min-w-0 flex-1 basis-32 font-mono text-xs"
						bind:value={row.name}
						disabled={row.stored}
						placeholder="X-Api-Key"
						aria-label="Header name"
					/>
					<input
						class="input input-sm input-bordered min-w-0 flex-[2] basis-40 font-mono text-xs"
						type="password"
						autocomplete="off"
						bind:value={row.value}
						disabled={row.remove}
						placeholder={row.stored ? (row.remove ? 'Will be removed' : 'Set — leave blank to keep it') : 'Value'}
						aria-label="Header value"
					/>
					<button type="button" class="btn btn-ghost btn-xs shrink-0" onclick={() => dropHeader(row)}>
						{row.stored && row.remove ? 'Keep' : 'Remove'}
					</button>
				</div>
			{/each}
			{#if liveHeaders < MAX_CONNECTOR_HEADERS}
				<button type="button" class="btn btn-ghost btn-xs" onclick={addHeader}>Add header</button>
			{/if}
		</fieldset>

		<label class="form-control max-w-xs">
			<span class="label-text text-xs">Call timeout (seconds, optional)</span>
			<input
				class="input input-sm input-bordered w-full"
				inputmode="decimal"
				bind:value={timeoutText}
				placeholder="CLI default"
				aria-label="Call timeout in seconds"
			/>
		</label>

		{#if needsKey}
			<div role="alert" class="alert alert-warning py-2 text-xs">
				This server has no APP_ENCRYPTION_KEY, so a token or header cannot be saved.
			</div>
		{/if}

		<div class="flex flex-wrap justify-end gap-2">
			<button type="button" class="btn btn-ghost btn-sm" onclick={onCancel} disabled={busy}>Cancel</button>
			<button type="submit" class="btn btn-sm" disabled={busy || Boolean(nameProblem)}>Save</button>
			<button
				type="button"
				class="btn btn-primary btn-sm"
				disabled={busy || Boolean(nameProblem)}
				onclick={() => void save(true)}
			>
				{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
				Save and test
			</button>
		</div>
	</div>
</form>
