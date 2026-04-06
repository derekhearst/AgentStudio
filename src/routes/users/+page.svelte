<svelte:head><title>Users | AGENTSTUDIO</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createUserCommand,
		listUsersQuery,
		restoreUserCommand,
		softDeleteUserCommand,
	} from '$lib/auth';

	type UserRow = Awaited<ReturnType<typeof listUsersQuery>>[number];

	let users = $state<UserRow[]>([]);
	let loading = $state(false);
	let errorMessage = $state('');
	let showCreate = $state(false);
	let username = $state('');
	let name = $state('');
	let role = $state<'admin' | 'user'>('user');

	async function loadUsers() {
		loading = true;
		errorMessage = '';
		try {
			users = await listUsersQuery();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load users';
		} finally {
			loading = false;
		}
	}

	async function createUser() {
		const normalized = username.trim();
		if (!normalized) return;
		await createUserCommand({ username: normalized, name: name.trim() || undefined, role });
		username = '';
		name = '';
		role = 'user';
		showCreate = false;
		await loadUsers();
	}

	async function removeUser(userId: string) {
		if (!confirm('Soft-delete this user? They will no longer be able to sign in.')) return;
		await softDeleteUserCommand(userId);
		await loadUsers();
	}

	async function restoreUser(userId: string) {
		await restoreUserCommand(userId);
		await loadUsers();
	}

	onMount(() => {
		void loadUsers();
	});
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
	<div class="flex items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">User management</h1>
			<p class="text-sm opacity-70">Create unclaimed accounts and soft-delete or restore access.</p>
		</div>
		<button class="btn btn-primary" type="button" onclick={() => (showCreate = true)}>Add account</button>
	</div>

	{#if errorMessage}
		<div class="alert alert-error"><span>{errorMessage}</span></div>
	{/if}

	<div class="overflow-x-auto rounded-xl border border-base-300 bg-base-100">
		<table class="table table-zebra">
			<thead>
				<tr>
					<th>Username</th>
					<th>Name</th>
					<th>Role</th>
					<th>Status</th>
					<th>Claimed</th>
					<th class="text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#if loading}
					<tr><td colspan="6" class="text-center opacity-70">Loading users...</td></tr>
				{:else if users.length === 0}
					<tr><td colspan="6" class="text-center opacity-70">No users found.</td></tr>
				{:else}
					{#each users as user (user.id)}
						<tr>
							<td class="font-mono text-sm">{user.username}</td>
							<td>{user.name}</td>
							<td><span class="badge badge-outline">{user.role}</span></td>
							<td>
								<span class={`badge ${user.deleted ? 'badge-error' : 'badge-success'}`}>
									{user.deleted ? 'deleted' : 'active'}
								</span>
							</td>
							<td>{user.claimed ? 'Yes' : 'No'}</td>
							<td>
								<div class="flex justify-end gap-2">
									{#if user.deleted}
										<button class="btn btn-xs" type="button" onclick={() => restoreUser(user.id)}>Restore</button>
									{:else}
										<button class="btn btn-xs btn-error btn-outline" type="button" onclick={() => removeUser(user.id)}>
											Remove
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>

<dialog class="modal" open={showCreate}>
	<div class="modal-box">
		<h3 class="text-lg font-semibold">Create account</h3>
		<p class="mt-1 text-sm opacity-70">Usernames will be claimed on first passkey registration.</p>
		<div class="mt-4 space-y-3">
			<label class="form-control">
				<span class="label-text">Username</span>
				<input class="input input-bordered" bind:value={username} placeholder="jane" />
			</label>
			<label class="form-control">
				<span class="label-text">Display name</span>
				<input class="input input-bordered" bind:value={name} placeholder="Jane" />
			</label>
			<label class="form-control">
				<span class="label-text">Role</span>
				<select class="select select-bordered" bind:value={role}>
					<option value="user">user</option>
					<option value="admin">admin</option>
				</select>
			</label>
		</div>
		<div class="modal-action">
			<button class="btn" type="button" onclick={() => (showCreate = false)}>Cancel</button>
			<button class="btn btn-primary" type="button" onclick={createUser} disabled={!username.trim()}>Create</button>
		</div>
	</div>
	<form method="dialog" class="modal-backdrop" onsubmit={() => (showCreate = false)}>
		<button>close</button>
	</form>
</dialog>
