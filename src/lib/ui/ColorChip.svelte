<script lang="ts">
	type ChipTone = 'primary' | 'accent' | 'success' | 'warning' | 'info';
	type Props = { label: string; tone?: ChipTone };
	let { label, tone = 'primary' }: Props = $props();

	const toneClassMap: Record<ChipTone, string> = {
		primary: 'badge-primary',
		accent: 'badge-secondary',
		success: 'badge-success',
		warning: 'badge-warning',
		info: 'badge-info'
	};
</script>

<span class={`badge badge-sm ${toneClassMap[tone]}`}>{label}</span>
