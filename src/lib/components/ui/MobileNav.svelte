<script lang="ts">
	let {
		activePath = '/',
		onNavigate
	} = $props<{ activePath?: string; onNavigate?: (() => void) | undefined }>();

	function isActive(href: string) {
		if (href === '/') return activePath === '/' || activePath.startsWith('/chat');
		return activePath.startsWith(href);
	}

	const moreItems = [
		{ href: '/memory', label: 'Memory' },
		{ href: '/activity', label: 'Activity' },
		{ href: '/review', label: 'Review' },
		{ href: '/artifacts', label: 'Artifacts' },
		{ href: '/skills', label: 'Skills' },
		{ href: '/tools', label: 'Tools' },
		{ href: '/cost', label: 'Cost' },
		{ href: '/settings', label: 'Settings' }
	];
	let moreLabel = $derived(moreItems.find((m) => activePath.startsWith(m.href))?.label);

	const navItems = [
		{
			href: '/',
			label: 'Chat',
			icon: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z'
		},
		{
			href: '/dashboard',
			label: 'Home',
			// squares-2x2
			paths: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z']
		},
		{
			href: '/tasks',
			label: 'Tasks',
			// check-circle
			paths: ['M9 12l2 2 4-4', 'circle:12,12,9']
		},
		{
			href: '/agents',
			label: 'Agents',
			// cpu
			paths: ['M7 7h10v10H7z', 'M7 9H4 M7 12H4 M7 15H4 M17 9h3 M17 12h3 M17 15h3 M9 7V4 M12 7V4 M15 7V4 M9 17v3 M12 17v3 M15 17v3']
		}
	] as const;
</script>

<nav class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 backdrop-blur-md xl:hidden safe-bottom">
	<div class="mx-auto flex max-w-lg items-center justify-around px-1 py-1">
		{#each navItems as item}
			<a
				href={item.href}
				class="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] transition-colors {isActive(item.href) ? 'font-semibold text-primary' : 'text-base-content/50'}"
				onclick={onNavigate}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5 shrink-0"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width={isActive(item.href) ? 2.5 : 1.8}
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					{#if item.href === '/'}
						<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
					{:else if item.href === '/dashboard'}
						<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
						<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
					{:else if item.href === '/tasks'}
						<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>
					{:else if item.href === '/agents'}
						<rect x="7" y="7" width="10" height="10" rx="1"/>
						<path d="M7 9H4M7 12H4M7 15H4M17 9h3M17 12h3M17 15h3M9 7V4M12 7V4M15 7V4M9 17v3M12 17v3M15 17v3"/>
					{/if}
				</svg>
				<span class="truncate">{item.label}</span>
			</a>
		{/each}

		<!-- More menu trigger -->
		<button
			type="button"
			class="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] transition-colors {moreLabel ? 'font-semibold text-primary' : 'text-base-content/50'}"
			popoverTarget="mobile-more-menu"
		>
			<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={moreLabel ? 2.5 : 1.8} stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
			</svg>
			<span class="truncate">{moreLabel ?? 'More'}</span>
		</button>
	</div>
</nav>

<!-- More menu popover -->
<div id="mobile-more-menu" popover class="mobile-more-popover">
	<div class="grid grid-cols-3 gap-1 p-3">
		{#each [
			{ href: '/memory', label: 'Memory', icon: 'db' },
			{ href: '/activity', label: 'Activity', icon: 'activity' },
			{ href: '/review', label: 'Review', icon: 'eye' },
			{ href: '/artifacts', label: 'Artifacts', icon: 'layers' },
			{ href: '/skills', label: 'Skills', icon: 'cap' },
			{ href: '/tools', label: 'Tools', icon: 'wrench' },
			{ href: '/cost', label: 'Cost', icon: 'dollar' },
			{ href: '/settings', label: 'Settings', icon: 'cog' }
		] as item}
			<a
				href={item.href}
				class="flex flex-col items-center gap-1 rounded-xl p-3 text-xs transition-colors hover:bg-base-200 {isActive(item.href) ? 'font-semibold text-primary' : 'text-base-content/70'}"
				onclick={() => {
					document.getElementById('mobile-more-menu')?.hidePopover();
					onNavigate?.();
				}}
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					{#if item.icon === 'db'}
						<ellipse cx="12" cy="5" rx="9" ry="3"/>
						<path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
						<path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
					{:else if item.icon === 'activity'}
						<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
					{:else if item.icon === 'eye'}
						<path d="M1 12S5 4 12 4s11 8 11 8-4 8-11 8S1 12 1 12z"/>
						<circle cx="12" cy="12" r="3"/>
					{:else if item.icon === 'layers'}
						<polygon points="12 2 2 7 12 12 22 7 12 2"/>
						<polyline points="2 17 12 22 22 17"/>
						<polyline points="2 12 12 17 22 12"/>
					{:else if item.icon === 'cap'}
						<path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
						<path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>
					{:else if item.icon === 'wrench'}
						<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.8-2.8z"/>
					{:else if item.icon === 'dollar'}
						<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
					{:else if item.icon === 'cog'}
						<circle cx="12" cy="12" r="3"/>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
					{/if}
				</svg>
				<span>{item.label}</span>
			</a>
		{/each}
	</div>
</div>

<style>
	.safe-bottom {
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}

	.mobile-more-popover {
		position: fixed;
		inset: auto 0.5rem 4.5rem;
		margin: 0;
		border: 1px solid var(--color-base-300);
		border-radius: 1rem;
		background: var(--color-base-100);
		box-shadow: 0 -4px 24px rgb(0 0 0 / 0.3);
		padding: 0;
		max-width: 400px;
		width: calc(100% - 1rem);
		left: 50%;
		transform: translateX(-50%);

		/* popover animation */
		opacity: 0;
		transition:
			opacity 150ms ease,
			transform 150ms ease,
			overlay 150ms ease allow-discrete,
			display 150ms ease allow-discrete;
		transform: translateX(-50%) translateY(8px);
	}

	.mobile-more-popover:popover-open {
		opacity: 1;
		transform: translateX(-50%) translateY(0);
	}

	@starting-style {
		.mobile-more-popover:popover-open {
			opacity: 0;
			transform: translateX(-50%) translateY(8px);
		}
	}
</style>
