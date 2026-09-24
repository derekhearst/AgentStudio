import type { ReviewItemType } from './observability.schema'

/**
 * What the inbox calls each review item type. A `Record` over the enum's type, so adding a
 * type without a label is a compile error rather than a filter option that is missing (or,
 * as happened with "PR checks failed", one the server refused).
 */
export const REVIEW_ITEM_TYPE_LABELS: Record<ReviewItemType, string> = {
	approval_request: 'Approval request',
	user_question: 'User question',
	evaluation_failure: 'Evaluation failure',
	job_failure: 'Job failure',
	job_stuck: 'Job stuck',
	hook_failure: 'Hook failure',
	memory_conflict: 'Memory conflict',
	policy_override_request: 'Policy override request',
	pull_request_ready: 'Pull request ready',
	pull_request_checks_failed: 'PR checks failed',
	automation_summary: 'Automation summary',
	monitor_fired: 'Monitor fired',
}
