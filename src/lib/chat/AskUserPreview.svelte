<script lang="ts">
	import { previewDocument } from '$lib/engine/ask-user-question';

	/**
	 * One option's preview (#4) — an HTML fragment the model wrote to show what the choice
	 * produces.
	 *
	 * Model output, so it is never put in the page. It goes into an `<iframe sandbox="">`:
	 * no scripts, no forms, no popups, and an opaque origin, so nothing in it can reach the app
	 * or act as the user. The document around it (`previewDocument`) also forbids every load,
	 * so an image pointing at someone's server is never fetched. A frame cannot size itself to
	 * its content without scripts, so it has a fixed height and scrolls.
	 */
	let { html, label }: { html: string; label: string } = $props();

	const srcdoc = $derived(previewDocument(html));
</script>

<figure class="ask-preview border-base-300 flex min-w-0 flex-col overflow-hidden rounded-xl border">
	<figcaption class="border-base-300 bg-base-200/60 flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
		<span class="shrink-0 opacity-60">Preview</span>
		<span class="min-w-0 truncate font-medium">{label}</span>
	</figcaption>
	<iframe
		title={`Preview: ${label}`}
		sandbox=""
		{srcdoc}
		referrerpolicy="no-referrer"
		loading="lazy"
		class="block h-56 w-full bg-white desktop:h-72"
	></iframe>
</figure>
