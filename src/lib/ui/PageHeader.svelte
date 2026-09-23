<script lang="ts">
	import type { Snippet } from 'svelte';
	import { openLeft, openRight } from '$lib/chat-console/mobile-drawer-state.svelte';

	type Crumb = { label: string; href?: string };

	let {
		title,
		crumbs = [],
		backHref,
		subtitle,
		live = false,
		chips,
		actions,
		mobileActions,
		showMenuButton = true,
		showRailButton = false,
	}: {
		title: string;
		crumbs?: Crumb[];
		backHref?: string;
		subtitle?: string;
		live?: boolean;
		chips?: Snippet;
		actions?: Snippet;
		mobileActions?: Snippet;
		showMenuButton?: boolean;
		showRailButton?: boolean;
	} = $props();

	// Name the destination when a crumb points at it: "Back to Agents" says more than "Back".
	const backLabel = $derived.by(() => {
		const target = crumbs.findLast((c) => c.href === backHref);
		return target ? `Back to ${target.label}` : 'Back';
	});
</script>

<!-- Desktop topbar: breadcrumb + status chips + action icons -->
<div class="console-topbar hidden desktop:grid">
	<div class="console-crumbs">
		{#each crumbs as c (c.label)}
			{#if c.href}
				<a href={c.href} class="console-crumbs__seg">{c.label}</a>
			{:else}
				<span class="console-crumbs__seg">{c.label}</span>
			{/if}
			<span class="console-crumbs__sep">/</span>
		{/each}
		<!--
			An <h1>, not a <span>: the mobile header below carries the only other copy of the
			page title and is display:none at desktop width, so before this every desktop page
			had no heading at all — nothing for a screen reader to navigate by, and nothing for
			a test to assert on. Tailwind preflight resets heading type and margin, so this
			renders exactly as the span did.
		-->
		<h1 class="console-crumbs__cur">{title}</h1>
	</div>
	{#if chips}
		<div class="console-topbar__chips">{@render chips()}</div>
	{:else}
		<div></div>
	{/if}
	{#if actions}
		<div class="console-topbar__actions">{@render actions()}</div>
	{:else}
		<div></div>
	{/if}
</div>

<!--
	Mobile/tablet header.

	Note that the page title exists twice in the DOM — once above, once here — with CSS
	hiding whichever does not belong at the current width. Both are <h1>, so only one is
	ever in the accessibility tree; a test that wants the live one should ask by role
	rather than taking the first text match.
-->
<div
	class="relative z-20 flex shrink-0 items-center gap-2 border-b border-base-300/50 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 desktop:hidden tablet:px-4 tablet:pt-2"
>
	{#if showMenuButton}
		<button
			type="button"
			class="console-iconbtn"
			aria-label="Open navigation"
			title="Menu"
			onclick={openLeft}
			style="width:32px;height:32px;border:1px solid var(--color-base-300);"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M4 6h16M4 12h16M4 18h16" />
			</svg>
		</button>
	{/if}
	<!--
		Beside the menu button, not instead of it. This was `{:else if backHref}`, and no page
		turns the menu off, so below 80rem no detail page had a way back: the breadcrumbs
		that carry the parent link live in the desktop topbar. In an installed PWA there is
		no browser Back either.
	-->
	{#if backHref}
		<a
			href={backHref}
			class="console-iconbtn"
			aria-label={backLabel}
			title={backLabel}
			style="width:32px;height:32px;border:1px solid var(--color-base-300);"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
			</svg>
		</a>
	{/if}
	<div class="min-w-0 flex-1 text-center">
		<h1 class="m-0 truncate text-sm font-semibold leading-tight">{title}</h1>
		{#if subtitle}
			<span class="console-mobile-sub">
				{#if live}<span class="pulse-dot"></span>{/if}
				{subtitle}
			</span>
		{/if}
	</div>
	{#if showRailButton}
		<button
			type="button"
			class="console-iconbtn"
			aria-label="Open chat rail"
			title="Open rail"
			onclick={openRight}
			style="width:32px;height:32px;border:1px solid var(--color-base-300);"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<line x1="15" y1="4" x2="15" y2="20" />
			</svg>
		</button>
	{/if}
	{#if mobileActions}
		{@render mobileActions()}
	{/if}
</div>

<!--
	Fall back to `actions` when a page has not written a separate `mobileActions`. No page
	ever did — the snippet was dead — so all 17 pages with header actions had them silently
	dropped on a phone. On /settings that meant Save and Reset simply did not exist below
	80rem.

	They go on their own scrollable row rather than beside the title: /memory has four of
	them, and inline they squeeze the `min-w-0 flex-1` title to zero width.
-->
{#if !mobileActions && actions}
	<div class="console-mobile-actions">{@render actions()}</div>
{/if}

{#if chips}
	<div class="console-mobile-chips">{@render chips()}</div>
{/if}
