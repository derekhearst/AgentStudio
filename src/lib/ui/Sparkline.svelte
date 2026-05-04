<!--
	Inline SVG sparkline — no library, no dependencies. Designed for the /review/health
	dashboard where each metric row gets a tiny 24h trend strip next to its latest value.

	Renders a polyline path scaled to the component's viewBox. The y-axis auto-fits to
	[min, max] across the input series (with min/max clamped together when the series is
	flat so the line still draws). When the series is too short to be useful (fewer than 2
	points) the component renders a horizontal line at the center to keep the layout stable.
-->
<script lang="ts">
	type Point = { value: number; measuredAt: string };

	interface Props {
		points?: Point[];
		width?: number;
		height?: number;
		strokeClass?: string;
		fillClass?: string;
		title?: string;
	}

	const {
		points = [],
		width = 96,
		height = 22,
		strokeClass = 'stroke-primary',
		fillClass = 'fill-primary/10',
		title = ''
	}: Props = $props();

	// Reduce to a polyline path string scaled to the SVG viewBox. Hardcoded 1px padding so
	// the stroke doesn't clip at the edges.
	const pad = 1.5;

	const path = $derived.by(() => {
		const n = points.length;
		if (n === 0) return { line: '', area: '' };
		// Single-value series: draw a flat line at center so the row still has a visible trend strip.
		if (n === 1) {
			const y = height / 2;
			return {
				line: `M ${pad} ${y} L ${width - pad} ${y}`,
				area: `M ${pad} ${y} L ${width - pad} ${y} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`
			};
		}
		const values = points.map((p) => p.value);
		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min || 1; // avoid div-by-zero on flat series
		const dx = (width - pad * 2) / (n - 1);
		const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
		const segments: string[] = [];
		for (let i = 0; i < n; i++) {
			const x = pad + i * dx;
			segments.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y(values[i]).toFixed(2)}`);
		}
		const line = segments.join(' ');
		const area = `${line} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
		return { line, area };
	});

	const summaryTitle = $derived(
		title ||
			(points.length > 0
				? `${points.length} samples · last ${points[points.length - 1].value} at ${new Date(points[points.length - 1].measuredAt).toLocaleString()}`
				: 'no data')
	);
</script>

<svg
	{width}
	{height}
	viewBox="0 0 {width} {height}"
	role="img"
	aria-label={summaryTitle}
	preserveAspectRatio="none"
	class="overflow-visible"
>
	<title>{summaryTitle}</title>
	{#if path.area}
		<path d={path.area} class={fillClass} stroke="none" />
	{/if}
	{#if path.line}
		<path d={path.line} class={strokeClass} stroke-width="1.25" fill="none" stroke-linecap="round" stroke-linejoin="round" />
	{/if}
	{#if points.length > 0}
		{@const last = points[points.length - 1]}
		{@const values = points.map((p) => p.value)}
		{@const min = Math.min(...values)}
		{@const max = Math.max(...values)}
		{@const range = max - min || 1}
		{@const lastY = height - pad - ((last.value - min) / range) * (height - pad * 2)}
		<circle cx={width - pad} cy={lastY} r="1.5" class={strokeClass} fill="currentColor" />
	{/if}
</svg>
