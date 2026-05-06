<script lang="ts">
	type AvatarSize = 'sm' | 'md' | 'lg';
	type Props = { name: string; size?: AvatarSize };

	let { name, size = 'md' }: Props = $props();

	const sizeClassMap = {
		sm: 'w-8 text-xs',
		md: 'w-10 text-sm',
		lg: 'w-14 text-lg'
	} as const;

	function toHue(input: string) {
		let hash = 0;
		for (let i = 0; i < input.length; i += 1) {
			hash = (hash << 5) - hash + input.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash) % 360;
	}

	const initials = $derived(
		name
			.split(' ')
			.filter(Boolean)
			.map((part: string) => part[0]?.toUpperCase() ?? '')
			.slice(0, 2)
			.join('') || 'DB'
	);
	const hue = $derived(toHue(name));
</script>

<div class="avatar avatar-placeholder" aria-label={`Avatar for ${name}`} style={`--avatar-hue: ${hue};`}>
	<div class={`avatar-tint text-primary-content rounded-2xl font-semibold shadow-sm ${sizeClassMap[size]}`}>
		<span>{initials}</span>
	</div>
</div>

<style>
	.avatar-tint {
		background: linear-gradient(
			140deg,
			oklch(60% 0.18 var(--avatar-hue)),
			oklch(54% 0.20 calc(var(--avatar-hue) + 50))
		);
	}

	:global([data-theme='AgentStudio']) .avatar-tint {
		background: linear-gradient(
			140deg,
			oklch(54% 0.16 var(--avatar-hue)),
			oklch(48% 0.18 calc(var(--avatar-hue) + 50))
		);
	}
</style>
