<script lang="ts">
	let {
		activePath = '/',
		onNavigate,
		slideOff = false
	} = $props<{ activePath?: string; onNavigate?: (() => void) | undefined; slideOff?: boolean }>();

	function isActive(href: string) {
		if (href === '/') return activePath === '/' || activePath.startsWith('/chat');
		return activePath.startsWith(href);
	}

	const moreItems = [
		{ href: '/activity', label: 'Activity' },
		{ href: '/skills', label: 'Skills' },
		{ href: '/automations', label: 'Automations' },
		{ href: '/cost', label: 'Cost' },
		{ href: '/settings', label: 'Settings' }
	] as const;

	let moreLabel = $derived(moreItems.find((m) => activePath.startsWith(m.href))?.label);

	let moreOpen = $state(false);
</script>

<nav
	class="z-20 mx-auto flex w-full max-w-400 justify-center px-3 py-2 tablet:hidden safe-bottom {slideOff
		? 'mobile-nav-slide-off'
		: ''}"
>
	<div class="dock dock-md bg-base-100/80 border-base-300/50 rounded-2xl border shadow-lg shadow-black/20 backdrop-blur-xl static w-full">
		<a
			href="/"
			class:dock-active={isActive('/')}
			onclick={onNavigate}
			aria-label="Chat"
		>
			<i class="mdi mdi-message-text-outline text-xl"></i>
			<span class="dock-label">Chat</span>
		</a>

		<a
			href="/agents"
			class:dock-active={isActive('/agents')}
			onclick={onNavigate}
			aria-label="Agents"
		>
			<i class="mdi mdi-chip text-xl"></i>
			<span class="dock-label">Agents</span>
		</a>

		<!-- More menu — DaisyUI dropdown opening upward -->
		<div class="dropdown dropdown-top dropdown-end" class:dropdown-open={moreOpen}>
			<button
				type="button"
				class:dock-active={!!moreLabel || moreOpen}
				onclick={() => (moreOpen = !moreOpen)}
				aria-label="More"
				aria-haspopup="true"
				aria-expanded={moreOpen}
			>
				<i class="mdi mdi-dots-vertical text-xl"></i>
				<span class="dock-label">{moreLabel ?? 'More'}</span>
			</button>
			{#if moreOpen}
				<ul
					class="menu dropdown-content bg-base-100 border-base-300 rounded-box z-50 mb-2 w-56 border p-2 shadow-lg"
				>
					{#each moreItems as item (item.href)}
						<li>
							<a
								href={item.href}
								class:menu-active={isActive(item.href)}
								onclick={() => {
									moreOpen = false;
									onNavigate?.();
								}}
							>
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</nav>

<style>
	.safe-bottom {
		padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
	}

	.mobile-nav-slide-off {
		position: absolute;
		inset-inline: 0;
		top: 0;
		animation: nav-slide-off-up 260ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
		pointer-events: none;
	}

	@keyframes nav-slide-off-up {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(-140%);
		}
	}
</style>
