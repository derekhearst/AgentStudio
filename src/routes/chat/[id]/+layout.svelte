<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();
</script>

<!--
	One chat page per conversation (#74).

	SvelteKit reuses a page component when only its params change, so opening another chat
	from the sidebar kept everything the page held for the first one: the running stream, its
	tool cards and Stop button, the unsent message, the error banner and its Retry. Every
	action then read the new conversation's id — Stop saved the old reply's partial text into
	the new conversation, Allow went to the wrong run, Retry sent the old prompt to the new
	chat. Keying on the id makes each conversation a fresh page, and the page lets go of its
	stream when it goes away.
-->
{#key page.params.id}
	{@render children()}
{/key}
