<svelte:head><title>Login | AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { invoke, isTauri } from '$lib/tauri';
	import {
		finishPasskeyLoginCommand,
		finishPasskeyRegistrationCommand,
		listLoginUsersQuery,
		startPasskeyLogin,
		startPasskeyRegistration,
	} from '$lib/auth/auth.remote';

	type LoginUser = Awaited<ReturnType<typeof listLoginUsersQuery>>[number];

	let users = $state<LoginUser[]>([]);
	let selectedUserId = $state('');
	let claimKey = $state(page.url.searchParams.get('claim') ?? '');
	let loading = $state(false);
	let openingBrowser = $state(false);
	let errorMessage = $state('');
	let browserFallbackError = $state('');
	let statusMessage = $state('');
	let passkeySupported = $state(true);

	const selectedUser = $derived(users.find((user) => user.id === selectedUserId) ?? null);
	const showBrowserFallback = $derived(!passkeySupported);

	async function detectPasskeySupport(): Promise<boolean> {
		if (typeof window === 'undefined') return false;
		if (!window.isSecureContext) return false;
		if (!('PublicKeyCredential' in window) || !navigator.credentials) return false;

		const canCheckPlatformAuthenticator =
			typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function';

		if (!canCheckPlatformAuthenticator) {
			return true;
		}

		try {
			return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
		} catch {
			return false;
		}
	}

	async function loadUsers() {
		users = await listLoginUsersQuery();
		if (!selectedUserId && users.length > 0) {
			selectedUserId = users[0].id;
		}
	}

	async function beginPasskeyFlow() {
		if (!selectedUserId || loading) return;
		if (!passkeySupported) {
			errorMessage = 'Passkeys are not available in this app webview. Use Open in browser to sign in.';
			return;
		}
		loading = true;
		errorMessage = '';
		statusMessage = '';

		try {
			if (!selectedUser?.claimed) {
				statusMessage = `Registering passkey for ${selectedUser?.username}...`;
				const init = await startPasskeyRegistration({
					userId: selectedUserId,
					claimKey: claimKey.trim() || undefined,
				});

				const response = await startRegistration({ optionsJSON: init.options });
				await finishPasskeyRegistrationCommand({
					challengeId: init.challengeId,
					response,
					claimKey: claimKey.trim() || undefined,
				});
			} else {
				statusMessage = `Authenticating ${selectedUser.username}...`;
				const init = await startPasskeyLogin({ userId: selectedUserId });
				const response = await startAuthentication({ optionsJSON: init.options });
				await finishPasskeyLoginCommand({ challengeId: init.challengeId, response });
			}

			await goto('/');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Authentication failed';
		} finally {
			loading = false;
		}
	}

	async function openInBrowserToSignIn() {
		if (openingBrowser) return;
		openingBrowser = true;
		browserFallbackError = '';

		try {
			const targetUrl = page.url.href;
			if (isTauri()) {
				await invoke('open_external_url', { url: targetUrl });
				statusMessage = 'Opened your default browser for sign-in.';
				return;
			}

			window.open(targetUrl, '_blank', 'noopener,noreferrer');
			statusMessage = 'Opened a new tab for sign-in.';
		} catch (error) {
			browserFallbackError =
				error instanceof Error ? error.message : 'Could not open browser. Copy this page URL into your browser.';
		} finally {
			openingBrowser = false;
		}
	}

	onMount(() => {
		void detectPasskeySupport().then((supported) => {
			passkeySupported = supported;
		});
		void loadUsers();
	});
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Sign in to AgentStudio</h1>
			<p class="text-sm opacity-70">Select your user account and continue with your passkey.</p>

			{#if showBrowserFallback}
				<div class="alert alert-warning mt-3">
					<span>This app webview does not support passkeys on this device.</span>
				</div>
			{/if}

			<div class="mt-4 space-y-4">
				<label class="form-control">
					<span class="label-text">User</span>
					<select class="select select-bordered w-full" bind:value={selectedUserId} disabled={loading || users.length === 0}>
						<option value="" disabled>Select a user</option>
						{#each users as user (user.id)}
							<option value={user.id}>{user.username} {user.claimed ? '(claimed)' : '(unclaimed)'}</option>
						{/each}
					</select>
				</label>

				{#if selectedUser && !selectedUser.claimed}
					<label class="form-control">
						<span class="label-text">Bootstrap claim key (first admin login only)</span>
						<input
							type="text"
							class="input input-bordered w-full"
							bind:value={claimKey}
							disabled={loading}
							autocomplete="off"
						/>
					</label>
				{/if}

				<button
					type="button"
					class="btn btn-primary mt-2 w-full"
					disabled={!selectedUserId || loading || users.length === 0 || !passkeySupported}
					onclick={beginPasskeyFlow}
				>
					{#if loading}
						<span class="loading loading-spinner loading-sm"></span>
					{/if}
					{selectedUser?.claimed ? 'Sign in with passkey' : 'Claim account with passkey'}
				</button>

				{#if showBrowserFallback}
					<button
						type="button"
						class="btn btn-outline w-full"
						onclick={openInBrowserToSignIn}
						disabled={openingBrowser}
					>
						{#if openingBrowser}
							<span class="loading loading-spinner loading-sm"></span>
						{/if}
						Open in browser to sign in
					</button>
					<p class="text-xs opacity-70">After opening, sign in in your browser and continue there.</p>
				{/if}

				{#if statusMessage}
					<p class="text-sm text-info">{statusMessage}</p>
				{/if}

				{#if errorMessage}
					<p class="text-sm text-error">{errorMessage}</p>
				{/if}

				{#if browserFallbackError}
					<p class="text-sm text-error">{browserFallbackError}</p>
				{/if}

				{#if users.length === 0}
					<p class="text-sm opacity-70">No users are available yet.</p>
				{/if}
			</div>
		</div>
	</div>
</div>
