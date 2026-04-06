<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let {
		activePath = '/',
		onNavigate
	} = $props<{ activePath?: string; onNavigate?: (() => void) | undefined }>();

	function isActive(href: string) {
		if (href === '/') return activePath === '/' || activePath.startsWith('/chat');
		return activePath.startsWith(href);
	}
</script>

<aside class="flex h-full w-56 flex-col bg-base-100/85 backdrop-blur-sm xl:rounded-2xl xl:border xl:border-base-300/50 xl:shadow-lg xl:shadow-black/20">
	<!-- Brand / user header -->
	<div class="flex items-center gap-2.5 border-b border-base-300/50 px-3 py-3 xl:rounded-t-2xl">
		<img src={favicon} alt="Agent Studio" class="size-8 shrink-0" />
		<div class="min-w-0">
			<p class="truncate text-sm leading-tight"><span class="font-light tracking-wide">Agent</span><span class="font-bold">Studio</span></p>
			<p class="truncate text-[10px] opacity-50">Autonomous Agent Console</p>
		</div>
	</div>

	<nav class="flex flex-1 flex-col overflow-y-auto px-2 py-3 text-sm">

		<!-- Chat — pinned top, prominent -->
		<a
			href="/"
			class="mb-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 font-semibold transition-colors"
			class:bg-primary={isActive('/')}
			class:text-primary-content={isActive('/')}
			class:hover:bg-primary={isActive('/')}
			class:hover:bg-base-200={!isActive('/')}
			class:text-base-content={!isActive('/')}
			onclick={onNavigate}
		>
			<!-- chat-bubble-left-right -->
			<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
				<circle cx="8" cy="11" r="1"/><circle cx="12" cy="11" r="1"/><circle cx="16" cy="11" r="1"/>
			</svg>
			Chat
		</a>

		<!-- Work group -->
		<p class="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest opacity-40">Work</p>
		<div class="mb-4 space-y-0.5">
			<a href="/dashboard"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/dashboard')} class:font-medium={isActive('/dashboard')} class:text-primary={isActive('/dashboard')}
				onclick={onNavigate}>
				<!-- squares-2x2 -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
					<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
				</svg>
				Dashboard
			</a>
			<a href="/agents"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/agents')} class:font-medium={isActive('/agents')} class:text-primary={isActive('/agents')}
				onclick={onNavigate}>
				<!-- cpu chip -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="7" y="7" width="10" height="10" rx="1"/>
					<path d="M7 9H4M7 12H4M7 15H4M17 9h3M17 12h3M17 15h3M9 7V4M12 7V4M15 7V4M9 17v3M12 17v3M15 17v3"/>
				</svg>
				Agents
			</a>
			<a href="/tasks"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/tasks')} class:font-medium={isActive('/tasks')} class:text-primary={isActive('/tasks')}
				onclick={onNavigate}>
				<!-- check-circle -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>
				</svg>
				Tasks
			</a>
			<a href="/review"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/review')} class:font-medium={isActive('/review')} class:text-primary={isActive('/review')}
				onclick={onNavigate}>
				<!-- eye -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M1 12S5 4 12 4s11 8 11 8-4 8-11 8S1 12 1 12z"/>
					<circle cx="12" cy="12" r="3"/>
				</svg>
				Review
			</a>
			<a href="/artifacts"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/artifacts')} class:font-medium={isActive('/artifacts')} class:text-primary={isActive('/artifacts')}
				onclick={onNavigate}>
				<!-- layers / documents -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polygon points="12 2 2 7 12 12 22 7 12 2"/>
					<polyline points="2 17 12 22 22 17"/>
					<polyline points="2 12 12 17 22 12"/>
				</svg>
				Artifacts
			</a>
			<a href="/skills"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/skills')} class:font-medium={isActive('/skills')} class:text-primary={isActive('/skills')}
				onclick={onNavigate}>
				<!-- academic-cap / skill -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
					<path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>
				</svg>
				Skills
			</a>
			<a href="/tools"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/tools')} class:font-medium={isActive('/tools')} class:text-primary={isActive('/tools')}
				onclick={onNavigate}>
				<!-- wrench -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.8-2.8z"/>
				</svg>
				Tools
			</a>
		</div>

		<!-- Insights group -->
		<p class="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest opacity-40">Insights</p>
		<div class="mb-4 space-y-0.5">
			<a href="/memory"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/memory')} class:font-medium={isActive('/memory')} class:text-primary={isActive('/memory')}
				onclick={onNavigate}>
				<!-- circle-stack / brain -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<ellipse cx="12" cy="5" rx="9" ry="3"/>
					<path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
					<path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
				</svg>
				Memory
			</a>
			<a href="/activity"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/activity')} class:font-medium={isActive('/activity')} class:text-primary={isActive('/activity')}
				onclick={onNavigate}>
				<!-- bolt / activity -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
				</svg>
				Activity
			</a>
			<a href="/cost"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/cost')} class:font-medium={isActive('/cost')} class:text-primary={isActive('/cost')}
				onclick={onNavigate}>
				<!-- currency dollar -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
				</svg>
				Cost
			</a>
		</div>

		<!-- Settings — pinned bottom -->
		<div class="mt-auto">
			<a href="/users"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/users')} class:font-medium={isActive('/users')} class:text-primary={isActive('/users')}
				onclick={onNavigate}>
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
					<circle cx="9" cy="7" r="4"/>
					<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
					<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
				</svg>
				Users
			</a>
			<a href="/settings"
				class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/settings')} class:font-medium={isActive('/settings')} class:text-primary={isActive('/settings')}
				onclick={onNavigate}>
				<!-- cog-6-tooth -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
				Settings
			</a>
		</div>
	</nav>
</aside>
