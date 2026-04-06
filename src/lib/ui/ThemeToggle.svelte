<script lang="ts">
	import { browser } from '$app/environment';

	let { className = '' } = $props<{ className?: string }>();

	const THEMES = ['drokbot', 'drokbot-night'] as const;
	type ThemeName = (typeof THEMES)[number];

	let theme = $state<ThemeName>('drokbot');

	function applyTheme(next: ThemeName) {
		theme = next;
		if (!browser) return;
		document.documentElement.setAttribute('data-theme', next);
		localStorage.setItem('drokbot-theme', next);
	}

	if (browser) {
		const saved = localStorage.getItem('drokbot-theme');
		if (saved === 'drokbot' || saved === 'drokbot-night') {
			theme = saved;
			document.documentElement.setAttribute('data-theme', saved);
		} else {
			const fromSystem: ThemeName = window.matchMedia('(prefers-color-scheme: dark)').matches
				? 'drokbot-night'
				: 'drokbot';
			theme = fromSystem;
			document.documentElement.setAttribute('data-theme', fromSystem);
			localStorage.setItem('drokbot-theme', fromSystem);
		}
	}

	function toggleTheme() {
		applyTheme(theme === 'drokbot' ? 'drokbot-night' : 'drokbot');
	}
</script>

<button class={`btn btn-sm btn-ghost ${className}`} type="button" onclick={toggleTheme} aria-label="Toggle theme">
	{#if theme === 'drokbot-night'}
		<span aria-hidden="true">Light</span>
	{:else}
		<span aria-hidden="true">Night</span>
	{/if}
</button>
