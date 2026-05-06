<script lang="ts">
	import { browser } from '$app/environment';

	let { className = '' } = $props<{ className?: string }>();

	const STORAGE_KEY = 'AgentStudio-theme';
	type ThemeName = 'AgentStudio' | 'AgentStudio-night';

	let isDark = $state(true);

	if (browser) {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === 'AgentStudio' || saved === 'AgentStudio-night') {
			isDark = saved === 'AgentStudio-night';
		} else {
			isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		}
	}

	function persist(checked: boolean) {
		isDark = checked;
		if (!browser) return;
		const next: ThemeName = checked ? 'AgentStudio-night' : 'AgentStudio';
		localStorage.setItem(STORAGE_KEY, next);
		// theme-controller's :has() selector will flip data-theme reactively, but
		// set it explicitly so server-rendered queries observing data-theme stay in sync.
		document.documentElement.setAttribute('data-theme', next);
	}
</script>

<label
	class={`swap swap-rotate btn btn-ghost btn-sm btn-circle ${className}`}
	aria-label="Toggle theme"
	title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
>
	<input
		type="checkbox"
		class="theme-controller"
		value="AgentStudio-night"
		checked={isDark}
		onchange={(e) => persist((e.currentTarget as HTMLInputElement).checked)}
	/>
	<i class="mdi mdi-white-balance-sunny swap-off text-lg" aria-hidden="true"></i>
	<i class="mdi mdi-moon-waxing-crescent swap-on text-lg" aria-hidden="true"></i>
</label>
