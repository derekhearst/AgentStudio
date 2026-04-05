<script lang="ts">
	import { onMount } from 'svelte';
	import ChatComposer from '$lib/components/chat/ChatComposer.svelte';

	let {
		busy = false,
		model = 'anthropic/claude-sonnet-4',
		onSubmit,
		onModelChange,
		onCancelGeneration,
		estimatedRemaining = 128000
	} = $props<{
		busy?: boolean;
		model?: string;
		onSubmit?: ((content: string) => Promise<void> | void) | undefined;
		onModelChange?: ((model: string) => Promise<void> | void) | undefined;
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
		value = '';
		baseText = '';
		await onSubmit?.(msg);
	}
</script>

<div class="space-y-2">
	<ChatComposer
		bind:value
		{busy}
		{model}
		{recording}
		{transcribing}
		{speechSupported}
		placeholder="Message DrokBot..."
		onSubmit={(content) => handleSubmit(content)}
		onModelChange={(id) => onModelChange?.(id)}
		onCancelGeneration={() => onCancelGeneration?.()}
		onAddFiles={() => {
			// File picker hook will be wired in a later pass.
		}}
		onMicClick={() => toggleRecording()}
	/>
</div>
