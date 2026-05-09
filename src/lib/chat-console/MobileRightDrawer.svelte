<script lang="ts">
	import Drawer from './Drawer.svelte';
	import ChatConsoleRail from './ChatConsoleRail.svelte';
	import { mobileDrawerState, closeAll } from './mobile-drawer-state.svelte';
</script>

<Drawer
	open={mobileDrawerState.right}
	side="right"
	onClose={closeAll}
	ariaLabel="Chat rail drawer"
>
	<ChatConsoleRail />
</Drawer>
