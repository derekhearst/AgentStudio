<script lang="ts">
	type AvatarSize = 'sm' | 'md' | 'lg';
	type Props = { name: string; size?: AvatarSize };

	let { name, size = 'md' }: Props = $props();

	const sizeClassMap = {
		sm: 'h-8 w-8 text-xs',
		md: 'h-10 w-10 text-sm',
		lg: 'h-14 w-14 text-lg'
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

<div
	class={`grid place-content-center rounded-2xl font-semibold text-white shadow-sm ${sizeClassMap[size]}`}
	style={`background: linear-gradient(140deg, hsl(${hue} 75% 52%), hsl(${(hue + 50) % 360} 82% 46%));`}
	aria-label={`Avatar for ${name}`}
>
	{initials}
</div>
