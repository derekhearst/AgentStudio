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

<aside class="flex h-full w-48 flex-col rounded-2xl border border-base-300/50 bg-base-100/85 shadow-lg shadow-black/20 backdrop-blur-sm desktop:w-56">
	<!-- Brand / user header -->
	<div class="brand-row flex items-center gap-2.5 border-b border-base-300/50 px-3 py-3 rounded-t-2xl">
		<img src={favicon} alt="Agent Studio" class="size-8 shrink-0" />
		<div class="brand-copy min-w-0">
			<p class="truncate text-sm leading-tight"><span class="font-light tracking-wide">Agent</span><span class="font-bold">Studio</span></p>
			<p class="hidden truncate text-[10px] opacity-50 desktop:block">Autonomous Agent Console</p>
		</div>
	</div>

	<nav class="nav-group flex flex-1 flex-col overflow-y-auto px-2 py-3 text-sm">

		<!-- Chat — pinned top, prominent -->
		<a
			href="/"
			class="nav-link mb-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 font-semibold transition-colors"
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
		<p class="nav-section-title mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest opacity-40">Work</p>
		<div class="mb-4 space-y-0.5">
			<a href="/agents"
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/agents')} class:font-medium={isActive('/agents')} class:text-primary={isActive('/agents')}
				onclick={onNavigate}>
				<!-- cpu chip -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="7" y="7" width="10" height="10" rx="1"/>
					<path d="M7 9H4M7 12H4M7 15H4M17 9h3M17 12h3M17 15h3M9 7V4M12 7V4M15 7V4M9 17v3M12 17v3M15 17v3"/>
				</svg>
				Agents
			</a>
			<a href="/review"
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/skills')} class:font-medium={isActive('/skills')} class:text-primary={isActive('/skills')}
				onclick={onNavigate}>
				<!-- academic-cap / skill -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
					<path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>
				</svg>
				Skills
			</a>
			<a href="/automations"
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/automations')} class:font-medium={isActive('/automations')} class:text-primary={isActive('/automations')}
				onclick={onNavigate}>
				<!-- refresh/cycle -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
				</svg>
				Automations
			</a>
		</div>

		<!-- Insights group -->
		<p class="nav-section-title mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest opacity-40">Insights</p>
		<div class="mb-4 space-y-0.5">
			<a href="/memory"
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
				class:bg-base-200={isActive('/activity')} class:font-medium={isActive('/activity')} class:text-primary={isActive('/activity')}
				onclick={onNavigate}>
				<!-- bolt / activity -->
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
				</svg>
				Activity
			</a>
			<a href="/cost"
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
				class="nav-link flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-base-200"
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
