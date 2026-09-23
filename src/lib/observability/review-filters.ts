import { z } from 'zod'
import { reviewItemStatusEnum, reviewItemTypeEnum } from './observability.schema'

/**
 * The inbox's list filters, validated against the database's own enums.
 *
 * The type list used to be copied out by hand, and the copy missed
 * `pull_request_checks_failed` when that type was added: picking "PR checks failed" in
 * /review failed validation, and the page kept showing the previous filter's items under the
 * new label. Reading the enum means a new item type is filterable the day it exists.
 */

export const REVIEW_ITEM_TYPES = reviewItemTypeEnum.enumValues
export const REVIEW_ITEM_STATUSES = reviewItemStatusEnum.enumValues

export const reviewItemListSchema = z
	.object({
		status: z.enum(REVIEW_ITEM_STATUSES).optional(),
		type: z.enum(REVIEW_ITEM_TYPES).optional(),
		severity: z.enum(['info', 'warning', 'critical']).optional(),
		openOnly: z.boolean().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	})
	.default({})
