<svelte:head><title>Login | AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { loginCommand } from '$lib/auth/auth.remote';

	let password = $state('');
	let loading = $state(false);
	let errorMessage = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!password) return;
		loading = true;
		errorMessage = '';
		try {
			await loginCommand({ password });
			await goto('/');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Sign in failed';
			password = '';
		} finally {
			loading = false;
		}
	}
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Sign in to AgentStudio</h1>

			<form class="mt-4 space-y-4" onsubmit={submit}>
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Password</legend>
					<input
						type="password"
						class="input input-bordered w-full"
						bind:value={password}
						autocomplete="current-password"
						required
					/>
				</fieldset>

				<button type="submit" class="btn btn-primary w-full" disabled={loading || !password}>
					{#if loading}
						<span class="loading loading-spinner loading-sm"></span>
					{/if}
					Sign in
				</button>

				{#if errorMessage}
					<p class="text-sm text-error">{errorMessage}</p>
				{/if}
			</form>
		</div>
	</div>
</div>
