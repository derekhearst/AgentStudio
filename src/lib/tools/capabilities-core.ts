import { capabilityGroups, type CapabilityGroup } from './tools'

/**
 * The capability groups whose `alwaysOn` flag is true — currently `['core']`. Computed once at
 * module load. Pure helpers below force these into every result so a row of all-NULL or an empty
 * array still yields a working tool surface.
 */
export const ALWAYS_ON_GROUPS: CapabilityGroup[] = (
	Object.entries(capabilityGroups) as Array<[CapabilityGroup, (typeof capabilityGroups)[CapabilityGroup]]>
)
	.filter(([, group]) => group.alwaysOn)
	.map(([name]) => name)

/**
 * Expand a list of enabled groups to the union of their tool names, deduplicated. Unknown group
 * names are silently dropped (forward-compat with future groups appearing in old run rows).
 *
 * Pure: no DB/IO. Tests can call this directly to assert the active surface for a given config.
 */
export function expandGroupsToToolNames(groups: CapabilityGroup[] | string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const g of groups) {
		const group = capabilityGroups[g as CapabilityGroup]
		if (!group) continue
		for (const tool of group.tools) {
			if (!seen.has(tool)) {
				seen.add(tool)
				out.push(tool)
			}
		}
	}
	return out
}

/**
 * Merge stored enabled-groups with always-on groups, keeping a stable ordering (alwaysOn first,
 * then user-enabled groups in insertion order). Filters out unknown group names.
 */
export function mergeAlwaysOn(stored: string[]): CapabilityGroup[] {
	const set = new Set<string>(stored.filter((g): g is string => typeof g === 'string'))
	for (const g of ALWAYS_ON_GROUPS) set.add(g)
	const valid = Array.from(set).filter((g): g is CapabilityGroup => g in capabilityGroups) as CapabilityGroup[]
	return [...ALWAYS_ON_GROUPS, ...valid.filter((g) => !ALWAYS_ON_GROUPS.includes(g))]
}
