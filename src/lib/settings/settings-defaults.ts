/**
 * Note on `dreamConfig` + `notificationPrefs.dreamSummary`:
 * Both fields are deprecated — the spec calls dream-run config out as removed
 * (background memory work moved into the memory domain). The DB columns stay
 * for migration compatibility but the application no longer reads or writes
 * them. A future destructive migration can drop them once we're confident no
 * downstream consumer references them.
 */
export const DEFAULT_SETTINGS = {
	defaultModel: 'claude-sonnet-5',
	transcriptionModel: 'google/gemini-2.5-flash',
	notificationPrefs: {
		taskCompleted: true,
		needsInput: true,
		agentErrors: true,
	},
	budgetConfig: {
		dailyLimit: null as number | null,
		monthlyLimit: null as number | null,
	},
	contextConfig: {
		reservedResponsePct: 30,
		autoCompactThresholdPct: 72,
	},
	toolConfig: {
		approvalRequiredTools: [] as string[],
		programmaticToolCallingEnabled: false,
	},
	memoryConfig: {
		enabled: true,
		topK: 5,
		useRerank: false,
		rerankModel: 'claude-haiku-4-5',
		embeddingModel: 'openai/text-embedding-3-small',
		autoMine: true,
	},
	theme: 'AgentStudio-night',
} as const
