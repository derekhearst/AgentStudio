<svelte:head><title>Set up AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { setupCommand } from '$lib/auth/auth.remote';

	let name = $state('');
	let username = $state('');
	let password = $state('');
	let confirm = $state('');
	let loading = $state(false);
	let errorMessage = $state('');

	const passwordsMatch = $derived(password === confirm);
	const passwordTooShort = $derived(password.length > 0 && password.length < 8);
	const canSubmit = $derived(
		!loading &&
			name.trim().length > 0 &&
			/^[a-zA-Z0-9_-]{3,32}$/.test(username.trim()) &&
			password.length >= 8 &&
			passwordsMatch,
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmit) return;
		loading = true;
		errorMessage = '';
		try {
			await setupCommand({ name: name.trim(), username: username.trim(), password });
			await goto('/');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Setup failed';
		} finally {
			loading = false;
		}
	}
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Welcome to AgentStudio</h1>
			<p class="text-sm opacity-70">Pick a username and password to set up the single owner account.</p>

			<form class="mt-4 space-y-4" onsubmit={submit}>
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Display name</legend>
					<input
						type="text"
						class="input input-bordered w-full"
						bind:value={name}
						autocomplete="name"
						required
					/>
				</fieldset>

				<fieldset class="fieldset">
					<legend class="fieldset-legend">Username</legend>
					<input
						type="text"
						class="input input-bordered w-full"
						bind:value={username}
						autocomplete="username"
						placeholder="3–32 letters, numbers, _ or -"
						required
					/>
				</fieldset>

				<fieldset class="fieldset">
					<legend class="fieldset-legend">Password</legend>
					<input
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
					<legend class="fieldset-legend">Confirm password</legend>
					<input
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
		</div>
	</div>
</div>
