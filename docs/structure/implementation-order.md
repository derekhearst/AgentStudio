# Master Implementation Order

## Purpose

This is the execution-order backlog for all planned domain work. It is optimized for autonomous agent execution with clear dependency gates and explicit parallel lanes.

## Ground Rules

- Do not start a wave until the previous wave gate is green.
- Within a wave, run independent lanes in parallel.
- Every lane must ship tests and docs updates before marking done.
- Favor thin vertical slices over broad partially-done refactors.
- Existing implementation is not a constraint: domains may be rewritten, restyled, or reorganized as needed to reach the target quality bar.

## Wave Map (Critical Path)

| Wave | Outcome                             | Domains                                            | Parallel Lanes |
| ---- | ----------------------------------- | -------------------------------------------------- | -------------- |
| 0    | Repo structure stable               | structure, llm, ui                                 | 3              |
| 1    | Core execution state stable         | runs, context, cost, chat, workspace               | 4              |
| 2    | Runtime composition stable          | tools, skills, runtime, tasks                      | 3              |
| 3    | Governance controls stable          | settings, hooks, evaluations                       | 3              |
| 4    | Feature services stable             | projects, memory, jobs, research                   | 4              |
| 5    | End-to-end product workflows stable | source-control, observability, automations, agents | 4              |

---

## Master TODO Backlog

### Completion Protocol (Required For Every TODO)

When any TODO item is finished, perform all closeout steps below before calling it done:

- [ ] Mark the TODO in this file from `[ ]` to `[x]`
- [ ] Update the domain plan file with a status line near the top:
  - `Status: active` while work is in progress
  - `Status: completed` when the plan is fully implemented
- [ ] Add a one-line completion note in the domain plan under a `Completion` section with date and PR/commit reference
- [ ] Ensure the domain is no longer listed as active in any lane or wave tracking notes

If any closeout checkbox is not done, the TODO is not complete.

### Wave 0 — Foundation

1. [x] Structure refactor (folders, imports, ownership boundaries)
   - Source: ../structure/plan.md
   - Blocks: all downstream waves
   - Gate: build/test passes; no unresolved imports; route parity verified
    - Evidence:
      - Domain rename slice completed: [src/lib/automations/index.ts](../../src/lib/automations/index.ts), [src/lib/costs/index.ts](../../src/lib/costs/index.ts)
      - Runs extraction slice completed: [src/lib/runs/index.ts](../../src/lib/runs/index.ts), [src/lib/runs/runs.server.ts](../../src/lib/runs/runs.server.ts), [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts)
    - Run schema ownership moved out of chat into runs: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts)
    - Run schema imports updated at call sites: [src/lib/chat/chat.remote.ts](../../src/lib/chat/chat.remote.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
    - Schema-level conversation/message dependencies moved behind sessions: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts), [src/lib/automations/automation.schema.ts](../../src/lib/automations/automation.schema.ts), [src/lib/memory/memory.schema.ts](../../src/lib/memory/memory.schema.ts), [src/lib/db.server.ts](../../src/lib/db.server.ts)
    - DB schema registration includes runs + sessions: [src/lib/db.server.ts](../../src/lib/db.server.ts)
    - Sessions scaffold started for chat split: [src/lib/sessions/index.ts](../../src/lib/sessions/index.ts), [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts)
    - Session schema ownership handoff completed: [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts)
    - Session imports moved in core flows: [src/lib/chat/chat.remote.ts](../../src/lib/chat/chat.remote.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts), [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts), [src/lib/memory/memory.server.ts](../../src/lib/memory/memory.server.ts), [src/lib/memory/retrieval.server.ts](../../src/lib/memory/retrieval.server.ts), [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
      - Compatibility shims removed after call-site migration: src/lib/chat/chat.schema.ts, src/lib/chat/runs.server.ts (deleted)
      - Monitor routes moved to runs domain: [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts)

2. [x] LLM consolidation (`openrouter.server.ts` + `models/` → `llm/`)
   - Source: ../llm/plan.md
   - Parallel with: #1 after target folders exist
   - Gate: all LLM callers moved; model list + chat streaming parity
    - Evidence:
      - New llm domain: [src/lib/llm/index.ts](../../src/lib/llm/index.ts), [src/lib/llm/chat.server.ts](../../src/lib/llm/chat.server.ts), [src/lib/llm/models.server.ts](../../src/lib/llm/models.server.ts), [src/lib/llm/models.remote.ts](../../src/lib/llm/models.remote.ts), [src/lib/llm/ModelSelector.svelte](../../src/lib/llm/ModelSelector.svelte)
      - Representative callers updated: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/chat/chat.server.ts](../../src/lib/chat/chat.server.ts), [src/lib/memory/mining.server.ts](../../src/lib/memory/mining.server.ts), [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
    - Legacy files removed (git diff evidence): openrouter.server.ts and models/* were deleted in this migration.
      - Plan closeout: [docs/llm/plan.md](../llm/plan.md)

UX-1. [x] UI platform and interaction system (cross-cutting) - Source: ../ui/plan.md - Starts in Wave 0 and continues through Wave 5 - Blocks: final UX acceptance for #6, #15, #18, #19, #20, #22 - Gate: desktop/mobile shell, action cards, and multi-session UX contracts implemented
     - Evidence:
         - Shell contract documented: [docs/ui/spec.md](../ui/spec.md) — Shell Implementation Contract
         - UI contract template added: [docs/ui/spec.md](../ui/spec.md) — Domain Integration Contracts
         - Running sessions dock: [src/lib/ui/RunningSessionsDock.svelte](../../src/lib/ui/RunningSessionsDock.svelte)
         - Unified action card: [src/lib/ui/ActionCard.svelte](../../src/lib/ui/ActionCard.svelte)
         - Dock wired into sidebar: [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)

### Wave 1 — Core Runtime Inputs/Outputs

3. [ ] Runs durability and resume semantics
   - Source: ../runs/plan.md
   - Gate: pause/resume/retry pass; blocked-state recovery proven

4. [ ] Context slot assembly + compaction invariants
   - Source: ../context/plan.md
   - Gate: token budget respected; tool call/result pair integrity preserved

5. [ ] Cost linkage (`runId/taskId/agentId`) + budget enforcement
   - Source: ../cost/plan.md
   - Depends on: #3
   - Gate: cost-by-run/task/agent dashboards query correctly

6. [ ] Chat mode system + inline approvals + HUD
   - Source: ../chat/plan.md
   - Depends on: #3, #4
   - Gate: mode switch anchors persisted; approval cards mutate durable state

7. [ ] Workspace sandbox baseline and task execution isolation
   - Source: ../workspace/plan.md
   - Gate: isolated workspaces proven with e2e checks

### Wave 2 — Orchestration Core

8. [ ] Tools progressive disclosure + capability gating
   - Source: ../tools/plan.md
   - Gate: default tool schema slim; `enable_capability` flow works

9. [ ] Skills taxonomy and loading rules (including mode identities)
   - Source: ../skills/plan.md
   - Depends on: #8 for companion-tool guidance
   - Gate: deterministic loading order and provenance visible

10. [ ] Runtime extraction/composition server
    - Source: ../runtime/plan.md
    - Depends on: #8, #9
    - Gate: chat SSE behavior parity; subagent orchestration parity

11. [ ] Task lifecycle alignment with runtime/runs
    - Source: ../tasks/plan.md
    - Depends on: #3, #10
    - Gate: plan→approve→execute transitions durable and replayable

### Wave 3 — Governance and Safety

12. [ ] Governance rules and enforcement points (approvals/denies/audit)
    - Source: ../settings/plan.md
    - Depends on: #8, #11
    - Gate: deny/approve/audit paths enforced server-side

13. [ ] Hook framework and hook execution contracts
    - Source: ../hooks/plan.md
    - Depends on: #9, #10, #12
    - Gate: hook timeout/isolation/failure handling verified

14. [ ] Evaluation framework integration
    - Source: ../evaluations/plan.md
    - Depends on: #3, #10
    - Gate: evaluation runs attach findings to durable records

### Wave 4 — Feature Service Layer

15. [ ] Project artifacts/versioning and linkage
    - Source: ../projects/plan.md
    - Depends on: #11
    - Gate: immutable version history + current pointer integrity

16. [ ] Memory extraction/retrieval + quality benchmark gates
    - Source: ../memory/plan.md
    - Depends on: #10
    - Gate: LongMemEval target achieved; retrieval latency/cost acceptable

17. [ ] Jobs queue/worker reliability and handler manifest
    - Source: ../jobs/plan.md
    - Depends on: #3, #11
    - Gate: retry/backoff/heartbeat/timeout behavior proven

18. [ ] Research loop domain (search→fetch→synthesize)
    - Source: ../research/plan.md
    - Depends on: #8, #17
    - Gate: report quality + source traceability + resumable progress

### Wave 5 — Product Workflow Integration

19. [ ] Source-control workflow (branch, diff, PR)
    - Source: ../source-control/plan.md
    - Depends on: #7, #11, #12
    - Gate: draft PR lifecycle + approval controls verified

20. [ ] Observability and review inbox consolidation
    - Source: ../observability/plan.md
    - Depends on: #12, #17
    - Gate: all human-required actions visible in one inbox

21. [ ] Automations scheduling and trigger framework
    - Source: ../automations/plan.md
    - Depends on: #11, #17, #20
    - Gate: trigger idempotency + failure recovery verified

22. [ ] Agents prompt-source + identity architecture
    - Source: ../agents/plan.md
    - Depends on: #9, #10
    - Gate: prompt edits hot-reload via skills; no hardcoded main-agent identity or agent-kind behavior

---

## Parallel Execution Lanes

Use these lanes for multi-agent execution. A lane can run independently once its dependencies are green.

### Lane A — Foundation/Core

- Wave 0: #1 + #2
- Wave 1: #3 + #7
- Wave 2: #10 + #11

### Lane B — Prompt/Tooling

- Wave 1: #4
- Wave 2: #8 + #9
- Wave 3: #13
- Wave 5: #22

### Lane C — Cost/Governance/Review

- Wave 1: #5 + #6
- Wave 3: #12 + #14
- Wave 5: #20

### Lane D — Async/Feature Services

- Wave 4: #15 + #16 + #17 + #18
- Wave 5: #19 + #21

### Lane E — UX Platform (Cross-Wave)

- Wave 0–5: UX-1
- Feeds: #6 + #15 + #18 + #19 + #20 + #22

---

## Mandatory Gate Checklist (Do Not Skip)

### Gate G0 (after Wave 0)

- [ ] App boots without import errors
    - Evidence: latest diagnostics are clean for changed Wave 0 surfaces: [src/lib/runs/runs.server.ts](../../src/lib/runs/runs.server.ts), [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts), [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts), [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts)
    - Evidence: client/server import boundary fixed for llm barrel: [src/lib/llm/index.ts](../../src/lib/llm/index.ts), [src/lib/chat/RecentChats.svelte](../../src/lib/chat/RecentChats.svelte), [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
- [ ] Playwright smoke tests pass
    - Evidence: Wave 0 smoke suite passes: [tests/wave0-smoke.spec.ts](../../tests/wave0-smoke.spec.ts) (2 passed) using [playwright.config.ts](../../playwright.config.ts).
    - Evidence: broader legacy UI-flow tests remain red and need modernization: [tests/chat.spec.ts](../../tests/chat.spec.ts), [tests/agents.spec.ts](../../tests/agents.spec.ts).
- [ ] No route regressions in chat, agents, settings
    - Evidence: route handlers updated and type-checked: [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/routes/settings/+page.svelte](../../src/routes/settings/+page.svelte)
- [ ] UI shell contract approved (desktop + mobile IA + action-card standards)
    - Evidence: pending UX-1 implementation and approval artifacts. Reference plan: [docs/ui/plan.md](../ui/plan.md)

### Gate G1 (after Wave 1)

- [ ] Run resume works after restart
- [ ] Context compaction keeps tool-call/result integrity
- [ ] Mode switching persists and injects anchor messages
- [ ] Cost rollups by run/task/agent query correctly

### Gate G2 (after Wave 2)

- [ ] Runtime extraction preserves stream output contract
- [ ] Tool capability gating works with approvals
- [ ] Skills load deterministically by mode + context

### Gate G3 (after Wave 3)

- [ ] Governance denies/approvals are enforced and audited
- [ ] Hook failures cannot crash active runs
- [ ] Evaluations emit durable findings attached to run/task

### Gate G4 (after Wave 4)

- [ ] Jobs survive process restarts with no loss
- [ ] Memory quality benchmark target met
- [ ] Research reports include source trace and reproducible steps

### Gate G5 (release gate)

- [ ] PR workflow + review inbox + automations form one coherent loop
- [ ] Agent identity editing works without code deploy
- [ ] Docs/spec/plan are updated for all touched domains

---

## Agent Handoff Template

Use this when assigning a lane item to an autonomous coding agent.

1. Objective: implement TODO #<id> from docs/structure/implementation-order.md
2. Inputs: linked domain plan + linked domain spec
3. Constraints:
   - preserve existing behavior unless plan explicitly changes it
   - ship tests for changed paths
   - update docs when logic changes
4. Deliverables:
   - code changes
   - migrations (if any)
   - tests
   - brief change log with risks
5. Mandatory closeout:
   - mark TODO `[x]` in this file
   - update the domain plan status to `completed`
   - add completion note (date + PR/commit)
6. Done when: corresponding gate criteria and closeout checklist are satisfied

---

## Known Follow-ups

- Add jobs handler manifest section in jobs plan to remove ambiguity across queue consumers.
- Continue replacing any remaining generic UI Contract boilerplate in non-UX-critical domains.
