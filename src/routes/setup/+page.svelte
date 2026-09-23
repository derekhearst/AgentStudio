<svelte:head><title>Set up AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { setupCommand } from '$lib/auth/auth.remote';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	let { data } = $props();

	let name = $state('');
	let username = $state('');
	let password = $state('');
	let confirm = $state('');
	let setupToken = $state('');
	let loading = $state(false);
	let errorMessage = $state('');

	const passwordsMatch = $derived(password === confirm);
	const passwordTooShort = $derived(password.length > 0 && password.length < 8);
	// Optional: blank means the default, `owner`. Nobody types it to sign in.
	const usernameValid = $derived(username.trim() === '' || /^[a-zA-Z0-9_-]{3,32}$/.test(username.trim()));
	const canSubmit = $derived(
		!loading &&
			name.trim().length > 0 &&
			usernameValid &&
			password.length >= 8 &&
			passwordsMatch &&
			(!data.setupTokenRequired || setupToken.trim().length > 0),
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmit) return;
		loading = true;
		errorMessage = '';
		try {
			await setupCommand({
				name: name.trim(),
				username: username.trim() || undefined,
				password,
				setupToken: data.setupTokenRequired ? setupToken.trim() : undefined,
			});
			// Same as /login: re-run the root layout so the shell sees the session just created.
			await goto('/', { invalidateAll: true });
		} catch (error) {
			errorMessage = remoteErrorMessage(error, 'Setup failed');
		} finally {
			loading = false;
		}
	}
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Welcome to AgentStudio</h1>
			<p class="text-sm opacity-70">
				Create the owner account. This is the only account on this instance; you will sign in with the password.
			</p>

			<form class="mt-4 space-y-4" onsubmit={submit}>
				{#if data.setupTokenRequired}
					<fieldset class="fieldset">
						<label class="fieldset-legend" for="setup-token">Setup token</label>
						<input
							id="setup-token"
							type="text"
							class="input input-bordered w-full font-mono"
							bind:value={setupToken}
							autocomplete="off"
							spellcheck="false"
							required
						/>
						<p class="text-xs opacity-70">
							Printed in the server log when the server started without an owner. It proves you run this server.
						</p>
					</fieldset>
				{/if}

				<fieldset class="fieldset">
					<label class="fieldset-legend" for="setup-name">Display name</label>
					<input
						id="setup-name"
						type="text"
						class="input input-bordered w-full"
						bind:value={name}
						autocomplete="name"
						required
					/>
				</fieldset>

				<fieldset class="fieldset">
					<label class="fieldset-legend" for="setup-password">Password</label>
					<input
						id="setup-password"
						type="password"
						class="input input-bordered w-full"
						bind:value={password}
						autocomplete="new-password"
						minlength="8"
						required
					/>
					{#if passwordTooShort}
						<p class="text-xs text-error">Password must be at least 8 characters.</p>
					{/if}
				</fieldset>

				<fieldset class="fieldset">
					<label class="fieldset-legend" for="setup-confirm">Confirm password</label>
					<input
						id="setup-confirm"
						type="password"
						class="input input-bordered w-full"
						bind:value={confirm}
						autocomplete="new-password"
						required
					/>
					{#if confirm.length > 0 && !passwordsMatch}
						<p class="text-xs text-error">Passwords don't match.</p>
					{/if}
				</fieldset>

				<details class="text-sm">
					<summary class="cursor-pointer opacity-70">Advanced</summary>
					<fieldset class="fieldset mt-2">
						<label class="fieldset-legend" for="setup-username">Username (optional)</label>
						<input
							id="setup-username"
							type="text"
							class="input input-bordered w-full"
							bind:value={username}
							autocomplete="username"
							placeholder="owner"
						/>
						{#if !usernameValid}
							<p class="text-xs text-error">3–32 letters, numbers, _ or -.</p>
						{/if}
					</fieldset>
				</details>

				<button type="submit" class="btn btn-primary w-full" disabled={!canSubmit}>
					{#if loading}
						<span class="loading loading-spinner loading-sm"></span>
					{/if}
					Create account
				</button>

				{#if errorMessage}
					<p class="text-sm text-error">{errorMessage}</p>
				{/if}
			</form>

			<p class="mt-2 text-xs opacity-60">
				Model sign-in, the workspace folder and integrations are set by whoever runs the server, not here. Settings → System
				shows what is configured. Starting the server with <code>AUTH_PASSWORD</code> set creates this account without
				this page.
			</p>
		</div>
	</div>
</div>
