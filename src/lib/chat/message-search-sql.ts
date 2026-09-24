/**
 * The SQL behind conversation search (#18), kept apart from the database client so it can be
 * rendered and checked without one. ./message-search.server runs it.
 */

import { sql, type SQL } from 'drizzle-orm'
import { conversations, messages, messageSearch } from '$lib/sessions/sessions.schema'
import { SEARCH_BUILDER_VERSION } from '$lib/chat/message-search-text'
import { searchQueryParts, SNIPPET_START, SNIPPET_STOP } from '$lib/chat/conversation-search'

/**
 * Tool blocks as the backfill reads them: what the builder uses and nothing else. A tool's
 * raw result and a `Write`'s file body can each be megabytes, and a batch of messages is
 * held in memory at once, so the trimming happens in Postgres before anything is sent.
 */
function trimmedWorkItems(column: SQL): SQL {
	return sql`(
		select coalesce(jsonb_agg(
			case
				when e.item->>'kind' = 'subagent' then jsonb_build_object(
					'kind', 'subagent',
					'agentName', e.item->'agentName',
					'task', to_jsonb(left(e.item->>'task', 2000)),
					'content', to_jsonb(left(e.item->>'content', 2000))
				)
				else jsonb_build_object(
					'kind', 'tool',
					'name', e.item->'name',
					'details', case when jsonb_typeof(e.item->'details') = 'object'
						then (e.item->'details') - 'stdout' - 'stderr' - 'hunks'
						else null end,
					'arguments', case when jsonb_typeof(e.item->'arguments') = 'object'
						then (e.item->'arguments') - 'content' - 'old_string' - 'new_string' - 'new_source' - 'edits'
						else to_jsonb(left(e.item->>'arguments', 20000)) end,
					'result', to_jsonb(left(coalesce(e.item->>'result', ''), 4000) || ' ' || right(coalesce(e.item->>'result', ''), 2000))
				)
			end
			order by e.ord
		) filter (
			where jsonb_typeof(e.item) = 'object'
				and coalesce(e.item->>'kind', 'tool') not in ('text', 'thinking', 'notice')
		), '[]'::jsonb)
		from jsonb_array_elements(case when jsonb_typeof(${column}) = 'array' then ${column} else '[]'::jsonb end)
			with ordinality as e(item, ord)
	)`
}

export type BackfillRow = {
	id: string
	conversation_id: string
	role: string
	content: string
	attachments: unknown
	blocks: unknown
	tool_calls: unknown
}

/**
 * The next `batchSize` messages after `cursor` (by id) that have no search row, or one built
 * by an older `SEARCH_BUILDER_VERSION`.
 */
export function backfillBatchQuery(cursor: string | null, batchSize: number): SQL {
	const after: SQL = cursor ? sql`and m.id > ${cursor}::uuid` : sql``
	return sql`
		select
			m.id,
			m.conversation_id,
			m.role,
			left(m.content, 50000) as content,
			m.attachments,
			${trimmedWorkItems(sql`m.metadata->'blocks'`)} as blocks,
			${trimmedWorkItems(sql`m.tool_calls`)} as tool_calls
		from ${messages} m
		left join ${messageSearch} ms on ms.message_id = m.id
		where (ms.message_id is null or ms.builder_version < ${SEARCH_BUILDER_VERSION}) ${after}
		order by m.id
		limit ${batchSize}
	`
}

/**
 * A message this short is its own snippet: the whole of it, with the matches marked. It fits
 * in the three lines the sidebar shows.
 */
export const SNIPPET_WHOLE_BODY_MAX_CHARS = 100

/** `ts_headline` options for a message short enough to show whole. */
export const WHOLE_BODY_HEADLINE_OPTIONS = `StartSel="${SNIPPET_START}", StopSel="${SNIPPET_STOP}", HighlightAll=true`

/**
 * `ts_headline` options for a longer message: up to two excerpts of about 18 words, each
 * centred on a match.
 *
 * `ShortWord=0` matters. By default Postgres will not start or end an excerpt on a word of
 * three letters or fewer, and trims them off the edges — which, when the excerpt reaches the
 * start or end of the message, can trim everything but the match itself: "fix the login
 * bug now" came back as just "login". Short messages are shown whole instead (above), and
 * this keeps the edges of longer ones.
 */
export const HEADLINE_OPTIONS = `StartSel="${SNIPPET_START}", StopSel="${SNIPPET_STOP}", MaxFragments=2, MaxWords=18, MinWords=6, ShortWord=0, FragmentDelimiter=" … "`

/** The highlighted snippet for `body` — see the two option sets above. */
export function snippetSql(body: SQL, tsq: SQL): SQL {
	return sql`case
		when length(${body}) <= ${SNIPPET_WHOLE_BODY_MAX_CHARS}
			then ts_headline('english', ${body}, ${tsq}, ${WHOLE_BODY_HEADLINE_OPTIONS})
		else ts_headline('english', ${body}, ${tsq}, ${HEADLINE_OPTIONS})
	end`
}

/** The Postgres text query for a search: `(exact OR segmented) AND prefix`. Null when empty. */
export function textQuery(raw: string): SQL | null {
	const parts = searchQueryParts(raw)
	const alternatives: SQL[] = []
	if (parts.exact) alternatives.push(sql`websearch_to_tsquery('english', ${parts.exact})`)
	if (parts.segmented) alternatives.push(sql`websearch_to_tsquery('english', ${parts.segmented})`)
	let query: SQL | null = alternatives.length > 0 ? sql`(${sql.join(alternatives, sql` || `)})` : null
	if (parts.prefix) {
		const prefix = sql`to_tsquery('english', ${parts.prefix})`
		query = query ? sql`(${query} && ${prefix})` : prefix
	}
	return query
}

export type ContentSearchRow = {
	conversation_id: string
	message_id: string
	rank: number
	title: string
	updated_at: Date | string
	pinned_at: Date | string | null
	archived_at: Date | string | null
	role: string
	message_created_at: Date | string
	snippet: string
}

/**
 * The best-matching message per conversation for one user, top `limit` conversations by rank,
 * with a highlighted snippet. `ts_headline` is the expensive part, so it runs only for those.
 */
export function contentSearchQuery(input: { userId: string; tsq: SQL; includeArchived: boolean; limit: number }): SQL {
	const { userId, tsq, includeArchived, limit } = input
	return sql`
		with best as (
			select distinct on (ms.conversation_id)
				ms.conversation_id,
				ms.message_id,
				ts_rank_cd(ms.tsv, ${tsq}) as rank
			from ${messageSearch} ms
			join ${conversations} c on c.id = ms.conversation_id
			where ms.tsv @@ ${tsq}
				and c.user_id = ${userId}
				${includeArchived ? sql`` : sql`and c.archived_at is null`}
			order by ms.conversation_id, rank desc, ms.message_id
		),
		top as (
			select * from best order by rank desc limit ${limit}
		)
		select
			top.conversation_id,
			top.message_id,
			top.rank,
			c.title,
			c.updated_at,
			c.pinned_at,
			c.archived_at,
			m.role,
			m.created_at as message_created_at,
			${snippetSql(sql`ms.body`, tsq)} as snippet
		from top
		join ${messageSearch} ms on ms.message_id = top.message_id
		join ${conversations} c on c.id = top.conversation_id
		join ${messages} m on m.id = top.message_id
		order by top.rank desc, c.updated_at desc
	`
}
