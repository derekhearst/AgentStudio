<svelte:head><title>Login | AgentStudio</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { loginCommand } from '$lib/auth/auth.remote';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

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
			// `invalidateAll`: the root layout's `{ user, authenticated }` was rendered for an
			// anonymous visitor and nothing else re-runs it, so without this the shell treats the
			// new session as anonymous (no credit balance, no `page.data.user`) until a reload.
			await goto('/', { invalidateAll: true });
		} catch (error) {
			errorMessage = remoteErrorMessage(error, 'Sign in failed');
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
					<!-- A <legend> names the fieldset, not the input, so the field had no
					     accessible name: screen readers announced an unlabelled text box and
					     getByLabel('Password') could not find it. An explicit label fixes
					     both. -->
					<label class="fieldset-legend" for="password">Password</label>
					<input
						id="password"
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
