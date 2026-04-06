<script lang="ts">
	import { onMount } from 'svelte';
	import ChatComposer from '$lib/chat/ChatComposer.svelte';

	type ChatAttachment = {
		id: string;
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	};

	type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

	let {
		busy = false,
		model = 'anthropic/claude-sonnet-4',
		reasoningEffort = 'none',
		onSubmit,
		onModelChange,
		onReasoningEffortChange,
		onCancelGeneration,
		estimatedRemaining = 128000
	} = $props<{
		busy?: boolean;
		model?: string;
		reasoningEffort?: ReasoningEffort;
		onSubmit?: ((content: string, attachments: ChatAttachment[]) => Promise<void> | void) | undefined;
		onModelChange?: ((model: string) => Promise<void> | void) | undefined;
		onReasoningEffortChange?: ((effort: ReasoningEffort) => Promise<void> | void) | undefined;
		onCancelGeneration?: (() => Promise<void> | void) | undefined;
		estimatedRemaining?: number;
	}>();

	let value = $state('');
	let recording = $state(false);
	let transcribing = $state(false);
	let speechSupported = $state(false);
	let useNativeSpeech = false;
	let recognition: SpeechRecognition | null = null;
	let mediaRecorder: MediaRecorder | null = null;
	let audioChunks: Blob[] = [];
	let baseText = '';
	let fileInputEl = $state<HTMLInputElement | undefined>(undefined);
	let attachments = $state<ChatAttachment[]>([]);
	let uploadBusy = $state(false);
	let uploadError = $state<string | null>(null);

	onMount(() => {
		const hasNative = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
		const hasMediaRecorder = typeof MediaRecorder !== 'undefined';
		useNativeSpeech = hasNative;
		speechSupported = hasNative || hasMediaRecorder;
	});

	function toggleRecording() {
		if (recording) {
			stopRecording();
			return;
		}
		if (useNativeSpeech) {
			startNativeSpeech();
		} else {
			startMediaRecorder();
		}
	}

	// --- Native Web Speech API (Chrome/Edge/Safari) ---
	function startNativeSpeech() {
		const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechAPI) return;

		baseText = value;
		recognition = new SpeechAPI();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = 'en-US';

		recognition.onresult = (event: SpeechRecognitionEvent) => {
			let final = '';
			let interim = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const transcript = event.results[i][0].transcript;
				if (event.results[i].isFinal) {
					final += transcript;
				} else {
					interim += transcript;
				}
			}
			if (final) {
				baseText += (baseText && !baseText.endsWith(' ') ? ' ' : '') + final;
			}
			value = baseText + (interim ? (baseText && !baseText.endsWith(' ') ? ' ' : '') + interim : '');
		};

		recognition.onend = () => {
			recording = false;
			recognition = null;
		};

		recognition.onerror = (event) => {
			if (event.error !== 'aborted') {
				console.warn('Speech recognition error:', event.error);
			}
			recording = false;
			recognition = null;
		};

		recognition.start();
		recording = true;
	}

	// --- MediaRecorder + server transcription (Firefox fallback) ---
	async function startMediaRecorder() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			audioChunks = [];
			mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });

			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) audioChunks.push(e.data);
			};

			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				if (audioChunks.length === 0) return;

				const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType ?? 'audio/webm' });
				audioChunks = [];
				mediaRecorder = null;
				await transcribeAudio(blob);
			};

			mediaRecorder.start();
			recording = true;
		} catch (err) {
			console.warn('Microphone access denied:', err);
		}
	}

	function getSupportedMimeType(): string {
		const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
		return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';
	}

	async function transcribeAudio(blob: Blob) {
		transcribing = true;
		try {
			const form = new FormData();
			form.append('audio', blob, 'recording.webm');
			const res = await fetch('/api/transcribe', { method: 'POST', body: form });
			if (!res.ok) {
				console.error('Transcription failed:', res.status);
				return;
			}
			const { transcript } = await res.json();
			if (transcript) {
				value += (value && !value.endsWith(' ') ? ' ' : '') + transcript;
			}
		} catch (err) {
			console.error('Transcription error:', err);
		} finally {
			transcribing = false;
		}
	}

	function stopRecording() {
		if (recognition) {
			recognition.stop();
			recognition = null;
		}
		if (mediaRecorder && mediaRecorder.state !== 'inactive') {
			mediaRecorder.stop();
		}
		recording = false;
	}

	async function handleSubmit(content: string) {
		if (!content.trim() || busy) return;
		stopRecording();
		const msg = content;
		const selectedAttachments = [...attachments];
		value = '';
		baseText = '';
		attachments = [];
		uploadError = null;
		await onSubmit?.(msg, selectedAttachments);
	}

	function formatBytes(size: number) {
		if (size < 1024) return `${size} B`;
		if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
		return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function uploadSingleFile(file: File): Promise<ChatAttachment> {
		const form = new FormData();
		form.append('file', file);
		const res = await fetch('/api/upload', { method: 'POST', body: form });
		if (!res.ok) {
			const payload = await res.json().catch(() => ({}));
			throw new Error(payload?.error ?? `Failed to upload ${file.name}`);
		}
		return (await res.json()) as ChatAttachment;
	}

	async function handleFilesSelected(event: Event) {
		const input = event.currentTarget as HTMLInputElement | null;
		const files = input?.files;
		if (!files || files.length === 0) return;

		uploadBusy = true;
		uploadError = null;
		try {
			const uploaded: ChatAttachment[] = [];
			for (const file of Array.from(files)) {
				uploaded.push(await uploadSingleFile(file));
			}
			const known = new Set(attachments.map((a) => a.id));
			attachments = [...attachments, ...uploaded.filter((a) => !known.has(a.id))];
		} catch (error) {
			uploadError = error instanceof Error ? error.message : 'Upload failed';
		} finally {
			uploadBusy = false;
			if (input) input.value = '';
		}
	}

	function openFilePicker() {
		if (busy || uploadBusy) return;
		fileInputEl?.click();
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((attachment) => attachment.id !== id);
	}
</script>

<div class="space-y-2">
	<input
		bind:this={fileInputEl}
		type="file"
		class="hidden"
		multiple
		accept="image/*,.pdf,.txt,.csv,.json,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		onchange={handleFilesSelected}
	/>

	<ChatComposer
		bind:value
		busy={busy || uploadBusy}
		{model}
		{reasoningEffort}
		{recording}
		{transcribing}
		{speechSupported}
		placeholder="Message AGENTSTUDIO..."
		onSubmit={(content) => handleSubmit(content)}
		onModelChange={(id) => onModelChange?.(id)}
		onReasoningEffortChange={(effort) => onReasoningEffortChange?.(effort)}
		onCancelGeneration={() => onCancelGeneration?.()}
		onAddFiles={() => openFilePicker()}
		onMicClick={() => toggleRecording()}
	/>

	{#if uploadError}
		<p class="px-1 text-xs text-error">{uploadError}</p>
	{/if}

	{#if attachments.length > 0}
		<div class="flex flex-wrap gap-2 px-1">
			{#each attachments as attachment (attachment.id)}
				<div class="flex items-center gap-2 rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs">
					<span class="max-w-44 truncate" title={attachment.filename}>{attachment.filename}</span>
					<span class="text-base-content/60">{formatBytes(attachment.size)}</span>
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-circle"
						title="Remove file"
						aria-label="Remove file"
						onclick={() => removeAttachment(attachment.id)}
					>
						×
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

