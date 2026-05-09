<script lang="ts">
	import ConsoleNavContent from './ConsoleNavContent.svelte';

	let { activePath = '/' }: { activePath?: string } = $props();
</script>

<aside class="console-sb">
	<ConsoleNavContent {activePath} variant="sidebar" />
</aside>
