<svelte:head><title>Login | DrokBot</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { loginAction } from './data.remote';

	$effect(() => {
		if (loginAction.result?.success) {
			void goto('/');
		}
	});
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 px-4">
	<div class="card w-full max-w-md bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="card-title text-2xl">Sign in to DrokBot</h1>
			<p class="text-sm opacity-70">Use your instance password to continue.</p>
			<form class="mt-4 space-y-4" {...loginAction}>
				<label class="form-control">
					<span class="label-text">Password</span>
					<input
						type="password"
						name="password"
						required
						autocomplete="current-password"
						class="input input-bordered w-full"
					/>
				</label>
				<button type="submit" class="btn btn-primary w-full">Sign in</button>
			</form>
		</div>
	</div>
</div>
