<script lang="ts">
	import ArtifactViewer from './ArtifactViewer.svelte';

	type ArtifactData = {
		id: string;
		type: string;
		title: string;
		content: string;
		language: string | null;
		mimeType: string | null;
		url: string | null;
		pinned: boolean;
	};

	type PanelMode = 'collapsed' | 'panel' | 'fullscreen';

	let {
		artifact = null,
		mode = 'collapsed',
		onClose,
		onPin,
	}: {
		artifact: ArtifactData | null;
		mode?: PanelMode;
		onClose?: () => void;
		onPin?: (id: string, pinned: boolean) => void;
	} = $props();

	let touchStartY = $state(0);

	function handleKeydown(event: KeyboardEvent) {
		if (!artifact) return;
		if (event.key === 'Escape') {
			if (mode === 'fullscreen') {
				mode = 'panel';
			} else {
				onClose?.();
			}
		}
		if (event.key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const target = event.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
			mode = mode === 'fullscreen' ? 'panel' : 'fullscreen';
		}
	}

	function toggleFullscreen() {
		mode = mode === 'fullscreen' ? 'panel' : 'fullscreen';
	}

	function handleTouchStart(event: TouchEvent) {
		touchStartY = event.touches[0].clientY;
	}

	function handleTouchEnd(event: TouchEvent) {
		const deltaY = event.changedTouches[0].clientY - touchStartY;
		if (deltaY > 80) {
			onClose?.();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if artifact && mode === 'fullscreen'}
	<!-- Fullscreen overlay -->
	<div
		class="fixed inset-0 z-50 flex flex-col bg-base-100"
		role="dialog"
		tabindex="-1"
		aria-label="Artifact fullscreen"
		ontouchstart={handleTouchStart}
		ontouchend={handleTouchEnd}
	>
		<ArtifactViewer
			{artifact}
			isFullscreen={true}
			onClose={onClose}
			onToggleFullscreen={toggleFullscreen}
			onPin={onPin}
		/>
	</div>

{:else if artifact && mode === 'panel'}
	<!-- Side panel -->
	<div
		class="flex h-full w-full flex-col"
		role="region"
		aria-label="Artifact panel"
		ontouchstart={handleTouchStart}
		ontouchend={handleTouchEnd}
	>
		<ArtifactViewer
			{artifact}
			isFullscreen={false}
			onClose={onClose}
			onToggleFullscreen={toggleFullscreen}
			onPin={onPin}
		/>
	</div>
{/if}
