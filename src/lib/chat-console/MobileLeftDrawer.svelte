<script lang="ts">
	import Drawer from './Drawer.svelte';
	import ConsoleNavContent from './ConsoleNavContent.svelte';
	import { mobileDrawerState, closeAll } from './mobile-drawer-state.svelte';

	let { activePath = '/' }: { activePath?: string } = $props();
</script>

<Drawer
	open={mobileDrawerState.left}
	side="left"
	onClose={closeAll}
	ariaLabel="Navigation drawer"
>
	<ConsoleNavContent {activePath} variant="drawer" onNavigate={closeAll} />
</Drawer>
