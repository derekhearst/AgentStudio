<script lang="ts">
	import type { Snippet } from 'svelte';

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
	}: {
		title: string;
		crumbs?: Crumb[];
		backHref?: string;
		subtitle?: string;
		live?: boolean;
		chips?: Snippet;
		actions?: Snippet;
		mobileActions?: Snippet;
	} = $props();
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
		<span class="console-crumbs__cur">{title}</span>
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

<!-- Mobile/tablet header -->
<div
	class="relative z-20 flex shrink-0 items-center gap-2 border-b border-base-300/50 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 desktop:hidden tablet:px-4 tablet:pt-2"
>
	{#if backHref}
		<a
			href={backHref}
			class="console-iconbtn"
			aria-label="Back"
			title="Back"
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
	{#if mobileActions}
		{@render mobileActions()}
	{/if}
</div>

{#if chips}
	<div class="console-mobile-chips">{@render chips()}</div>
{/if}
