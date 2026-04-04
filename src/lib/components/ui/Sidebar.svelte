<script lang="ts">
	import Avatar from './Avatar.svelte';

	type NavGroup = {
		title: string;
		links: Array<{ href: string; label: string }>;
	};

	let {
		activePath = '/',
		onNavigate
	} = $props<{ activePath?: string; onNavigate?: (() => void) | undefined }>();

	const navGroups: NavGroup[] = [
		{
			title: 'Workspace',
			links: [
				{ href: '/', label: 'Dashboard' },
				{ href: '/chat', label: 'Chat' },
				{ href: '/agents', label: 'Agents' },
				{ href: '/tasks', label: 'Tasks' },
				{ href: '/review', label: 'Review Queue' }
			]
		},
		{
			title: 'Knowledge',
			links: [
				{ href: '/memory', label: 'Memory' },
				{ href: '/activity', label: 'Activity' },
				{ href: '/dashboard/cost', label: 'Cost' },
				{ href: '/settings', label: 'Settings' }
			]
		}
	];

	function isActive(href: string) {
		return href === '/' ? activePath === '/' : activePath.startsWith(href);
	}
</script>

<aside class="h-full w-72 border-r border-base-300 bg-base-100/95 backdrop-blur-sm">
	<div class="flex items-center gap-3 border-b border-base-300 px-4 py-4">
		<Avatar name="Derek User" />
		<div>
			<p class="font-semibold">DrokBot</p>
			<p class="text-xs opacity-65">Autonomous Agent Console</p>
		</div>
	</div>

	<nav class="space-y-4 p-3">
		{#each navGroups as group (group.title)}
			<section>
				<h2 class="px-2 pb-2 text-xs font-semibold uppercase tracking-wide opacity-55">{group.title}</h2>
				<div class="space-y-1">
					{#each group.links as link (link.href)}
						<a
							href={link.href}
							class="btn btn-ghost w-full justify-start"
							class:btn-active={isActive(link.href)}
							onclick={onNavigate}
						>
							{link.label}
						</a>
					{/each}
				</div>
			</section>
		{/each}
	</nav>
</aside>
