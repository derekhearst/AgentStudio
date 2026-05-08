<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import RunningSessionsDock from '$lib/ui/RunningSessionsDock.svelte';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';

	let {
		activePath = '/',
		onNavigate
	} = $props<{ activePath?: string; onNavigate?: (() => void) | undefined }>();

	function isActive(href: string) {
		if (href === '/') return activePath === '/' || activePath.startsWith('/chat');
		return activePath.startsWith(href);
	}
</script>

<aside
	class="bg-base-100/85 border-base-300/50 flex h-full w-48 flex-col rounded-2xl border shadow-lg shadow-black/20 backdrop-blur-sm desktop:w-56"
>
	<!-- Brand / user header — DaisyUI navbar -->
	<div class="navbar border-base-300/50 rounded-t-2xl border-b px-3 py-3 min-h-0">
		<div class="flex w-full items-center gap-2.5">
			<img src={favicon} alt="Agent Studio" class="size-8 shrink-0" />
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm leading-tight">
					<span class="font-light tracking-wide">Agent</span><span class="font-bold">Studio</span>
				</p>
				<p class="hidden truncate text-[10px] opacity-50 desktop:block">Autonomous Agent Console</p>
			</div>
			<ThemeToggle />
		</div>
	</div>

	<div class="flex flex-1 flex-col overflow-y-auto px-2 py-3">
		<!-- Chat — pinned top, prominent -->
		<ul class="menu menu-md w-full p-0 mb-3">
			<li>
				<a
					href="/"
					class:menu-active={isActive('/')}
					class="font-semibold"
					onclick={onNavigate}
				>
					<i class="mdi mdi-message-text-outline text-base shrink-0"></i>
					Chat
				</a>
			</li>
		</ul>

		<!-- Work group -->
		<ul class="menu menu-sm w-full p-0 mb-4">
			<li class="menu-title">Work</li>
			<li>
				<a href="/agents" class:menu-active={isActive('/agents')} onclick={onNavigate}>
					<i class="mdi mdi-chip text-base shrink-0 opacity-60"></i>
					Agents
				</a>
			</li>
			<li>
				<a href="/skills" class:menu-active={isActive('/skills')} onclick={onNavigate}>
					<i class="mdi mdi-school-outline text-base shrink-0 opacity-60"></i>
					Skills
				</a>
			</li>
			<li>
				<a href="/automations" class:menu-active={isActive('/automations')} onclick={onNavigate}>
					<i class="mdi mdi-sync text-base shrink-0 opacity-60"></i>
					Automations
				</a>
			</li>
			<li>
				<a href="/projects" class:menu-active={isActive('/projects')} onclick={onNavigate}>
					<i class="mdi mdi-folder-outline text-base shrink-0 opacity-60"></i>
					Projects
				</a>
			</li>
		</ul>

		<!-- Insights group -->
		<ul class="menu menu-sm w-full p-0 mb-4">
			<li class="menu-title">Insights</li>
			<li>
				<a href="/review" class:menu-active={isActive('/review')} onclick={onNavigate}>
					<i class="mdi mdi-view-dashboard-outline text-base shrink-0 opacity-60"></i>
					Review
				</a>
			</li>
			<li>
				<a href="/activity" class:menu-active={isActive('/activity')} onclick={onNavigate}>
					<i class="mdi mdi-lightning-bolt-outline text-base shrink-0 opacity-60"></i>
					Activity
				</a>
			</li>
			<li>
				<a href="/memory" class:menu-active={isActive('/memory')} onclick={onNavigate}>
					<i class="mdi mdi-database-outline text-base shrink-0 opacity-60"></i>
					Memory
				</a>
			</li>
			<li>
				<a href="/artifacts" class:menu-active={isActive('/artifacts')} onclick={onNavigate}>
					<i class="mdi mdi-folder-multiple-outline text-base shrink-0 opacity-60"></i>
					Artifacts
				</a>
			</li>
		</ul>

		<!-- Settings — pinned bottom -->
		<div class="mt-auto">
			<RunningSessionsDock />
			<ul class="menu menu-sm w-full p-0">
				<li>
					<a href="/audit" class:menu-active={isActive('/audit')} onclick={onNavigate}>
						<i class="mdi mdi-shield-check-outline text-base shrink-0 opacity-60"></i>
						Audit
					</a>
				</li>
				<li>
					<a href="/settings/hooks" class:menu-active={isActive('/settings/hooks')} onclick={onNavigate}>
						<i class="mdi mdi-hook text-base shrink-0 opacity-60"></i>
						Hooks
					</a>
				</li>
				<li>
					<a href="/settings/jobs" class:menu-active={isActive('/settings/jobs')} onclick={onNavigate}>
						<i class="mdi mdi-format-list-bulleted text-base shrink-0 opacity-60"></i>
						Jobs
					</a>
				</li>
				<li>
					<a href="/settings" class:menu-active={activePath === '/settings'} onclick={onNavigate}>
						<i class="mdi mdi-cog-outline text-base shrink-0 opacity-60"></i>
						Settings
					</a>
				</li>
			</ul>
		</div>
	</div>
</aside>
