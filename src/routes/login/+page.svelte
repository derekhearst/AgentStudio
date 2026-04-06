<svelte:head><title>Login | AGENTSTUDIO</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
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
	let errorMessage = $state('');
	let statusMessage = $state('');

	const selectedUser = $derived(users.find((user) => user.id === selectedUserId) ?? null);

	async function loadUsers() {
		users = await listLoginUsersQuery();
		if (!selectedUserId && users.length > 0) {
			selectedUserId = users[0].id;
		}
	}

	async function beginPasskeyFlow() {
		if (!selectedUserId || loading) return;
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

	onMount(() => {
		void loadUsers();
	});
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Sign in to AGENTSTUDIO</h1>
			<p class="text-sm opacity-70">Select your user account and continue with your passkey.</p>

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
					disabled={!selectedUserId || loading || users.length === 0}
					onclick={beginPasskeyFlow}
				>
					{#if loading}
						<span class="loading loading-spinner loading-sm"></span>
					{/if}
					{selectedUser?.claimed ? 'Sign in with passkey' : 'Claim account with passkey'}
				</button>

				{#if statusMessage}
					<p class="text-sm text-info">{statusMessage}</p>
				{/if}

				{#if errorMessage}
					<p class="text-sm text-error">{errorMessage}</p>
				{/if}

				{#if users.length === 0}
					<p class="text-sm opacity-70">No users are available yet.</p>
				{/if}
			</div>
		</div>
	</div>
</div>
