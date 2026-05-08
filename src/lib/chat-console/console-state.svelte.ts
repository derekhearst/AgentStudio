// Console redesign — shared $state runes store.
// The chat detail page writes streaming/context data here so the right rail
// (rendered above the page in the layout tree) can read it without prop drilling.

type ToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';

export type ConsoleStreamingBlock =
	| { kind: 'text'; id: string; content: string }
	| {
			kind: 'tool';
			id: string;
			name: string;
			arguments: string;
			status: ToolStatus;
			result?: string;
			executionMs?: number | null;
	  }
	| { kind: 'thinking'; id: string; content: string }
	| { kind: 'subagent'; id: string; agentName: string; task: string; status: 'running' | 'completed' | 'failed' };

export type ConsoleLiveContext = {
	tokenEstimate: number | null;
	contextWindow: number | null;
	didCompact: boolean;
};

export type ConsoleRunStatus = {
	state: 'idle' | 'running' | 'streaming' | 'waiting_tool_approval' | 'waiting_user_input';
	startedAt: number | null;
	pendingApprovals: number;
};

export const consoleState = $state({
	conversationId: null as string | null,
	conversationTitle: null as string | null,
	streamingBlocks: [] as ConsoleStreamingBlock[],
	persistedToolCalls: [] as Array<{ name: string; success?: boolean; ageMin: number }>,
	liveContext: null as ConsoleLiveContext | null,
	runStatus: { state: 'idle', startedAt: null, pendingApprovals: 0 } as ConsoleRunStatus,
	totalTokens: 0,
	totalCostUsd: 0,
	lastTtftMs: null as number | null,
});

export function resetConsoleState() {
	consoleState.conversationId = null;
	consoleState.conversationTitle = null;
	consoleState.streamingBlocks = [];
	consoleState.persistedToolCalls = [];
	consoleState.liveContext = null;
	consoleState.runStatus = { state: 'idle', startedAt: null, pendingApprovals: 0 };
	consoleState.totalTokens = 0;
	consoleState.totalCostUsd = 0;
	consoleState.lastTtftMs = null;
}
