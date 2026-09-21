/**
 * #33 — monitors barrel. Server-side surface; the `/monitors` page imports
 * `monitors.remote` and `condition` directly so no server module reaches the browser.
 */

export {
	monitors,
	monitorStatusEnum,
	monitorConditionKindEnum,
	monitorActionEnum,
	type MonitorRow,
	type MonitorStatus,
	type MonitorConditionKind,
} from './monitors.schema'

export {
	MONITOR_DEFAULT_INTERVAL_SECONDS,
	MONITOR_DEFAULT_MAX_CHECKS,
	MONITOR_HARD_MAX_CHECKS,
	MONITOR_MAX_CONSECUTIVE_ERRORS,
	MONITOR_MAX_DEADLINE_DAYS,
	MONITOR_MAX_INTERVAL_SECONDS,
	MONITOR_MIN_INTERVAL_SECONDS,
	MONITOR_OBSERVABLE_TOOLS,
	buildObservation,
	clampDeadline,
	clampInterval,
	clampMaxChecks,
	computeNextCheckAt,
	describeCondition,
	evaluateComparison,
	extractPath,
	hashValue,
	isTerminalStatus,
	monitorActionConfigSchema,
	monitorActionSchema,
	monitorConditionSchema,
	parseYesNo,
	shouldFire,
	stableStringify,
	validateActionConfig,
	type MonitorAction,
	type MonitorActionConfig,
	type MonitorCompare,
	type MonitorCondition,
	type MonitorObservableTool,
	type MonitorObservation,
} from './condition'

export {
	cancelMonitor,
	claimMonitorForCheck,
	createMonitor,
	expireOverdueMonitors,
	extendMonitor,
	getMonitorById,
	getMonitorForUser,
	listDueMonitors,
	listMonitorsForUser,
	remainingLifetimeMs,
	setMonitorPaused,
	setMonitorStatus,
	updateMonitorSettings,
	MONITOR_MAX_ACTIVE_PER_USER,
	type CreateMonitorInput,
	type ExtendMonitorInput,
	type ListMonitorsFilters,
	type UpdateMonitorSettingsInput,
} from './monitors.server'

export { evaluateMonitorCondition, type MonitorEvaluation } from './evaluate.server'
export { dispatchMonitorAction, type MonitorFireResult } from './actions.server'
export { runMonitorCheck, type MonitorCheckResult } from './run.server'
export {
	registerMonitorJobHandlers,
	dispatchDueMonitors,
	type DispatchDueMonitorsResult,
} from './monitors-handler.server'
