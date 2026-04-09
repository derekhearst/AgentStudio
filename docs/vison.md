# AgentStudio — Vision

## What AgentStudio Is

AgentStudio is a self-hosted AI platform where conversation is the only interface. You talk to one orchestrator, and it runs your entire digital life — coding, research, monitoring, planning, creating. You never fill out a form, configure a setting through a UI, or manually assign a task. You just talk, and the system figures out the rest.

Everything flows through the orchestrator. Everything reports back to the orchestrator. Your chat is the single source of truth for every action taken on your behalf.

## The Orchestrator

The orchestrator is not an agent. It is the platform's brain. It sits above every agent, every task, every project, and every tool. It knows your memory, your preferences, your active projects, your goals, and the current state of every running workflow. When you speak to AgentStudio, you are speaking to the orchestrator.

The orchestrator's job is to understand what you want and decompose it into work. When you say "something's broken in the auth flow," it doesn't start writing code. It reasons about what needs to happen, plans a pipeline of work, creates tasks with dependencies, assigns the right specialist agents, and monitors the whole thing to completion. It is a dispatcher, a coordinator, and a narrator — never a laborer.

When work is finished, the orchestrator is the one who tells you. Sub-agents never talk to you directly. They report back to the orchestrator, and the orchestrator weaves their results into your ongoing conversation. You open your chat and see a coherent story of everything that happened, even while you were away. Your original request, followed by updates from each stage of execution, ending with a result ready for your review.

## Sub-Agents

Sub-agents are specialists. A coding agent understands code, has access to the filesystem and sandbox, and runs on a frontier model. A research agent searches the web, extracts content, and synthesizes findings on a cheaper, high-volume model. A testing agent runs Playwright suites and records video proof. Each agent has a focused system prompt, a scoped tool set, and a model assignment tuned for its job.

Sub-agents exist because context isolation matters. When the coding agent is deep in a file diff, that context shouldn't pollute your main chat. When the research agent is processing 20 search results, that volume shouldn't crowd out the orchestrator's reasoning. Each specialist works in its own context window and reports a clean summary back up the chain.

Sub-agents don't make decisions about what to do next. They do what they're assigned and signal completion. The orchestrator decides what happens after that — kick off the next agent in the pipeline, request changes, mark the work as ready for review, or loop back for another attempt.

## Pipelines, Not Tasks

When the orchestrator receives a request, it doesn't create a single task. It plans an entire pipeline. "Fix the auth bug" becomes: coding agent diagnoses and patches, testing agent verifies, documentation agent updates if the change affects the API. All planned upfront, all dependencies defined, all agents assigned before any work begins. The orchestrator's initial reasoning captures the full plan cleanly in its context window.

This is important. The plan is made once, at the beginning, with full context. As agents execute and report back, the orchestrator follows the plan — not re-reasoning from scratch at each step. This keeps the orchestration coherent and predictable.

## Automation Through Conversation

There are no cron job configuration forms. There are no scheduling UIs. Automation is just the orchestrator receiving messages on a timer.

When you say "every Monday morning, check for new SvelteKit features and summarize what I should know," the orchestrator remembers that as a recurring instruction. Under the hood, a cron entry fires a message to the orchestrator at the scheduled time. The orchestrator receives it exactly as if you typed it yourself — with full context about who you are, what you're working on, and what matters to you. It then reasons, plans, assigns agents, and executes. Same flow. Same pipeline. Same reporting back to your chat.

If you want to see what's scheduled, you ask. If you want to change something, you say so. The orchestrator handles the rest. No forms. No settings panels. No dropdowns.

## The UI Is a Window, Not a Control Panel

AgentStudio has pages — a task board, a cost dashboard, a memory explorer, agent profiles, project views. These are read-only windows into what's happening. You look at the Kanban board to see where tasks stand. You look at the cost dashboard to understand spending. You browse the memory explorer to see what the system knows about you.

But you never create or edit anything through these views. Every action that changes state flows through the orchestrator via conversation. The task board doesn't have a "new task" button. The agent page doesn't have a configuration form. The settings page doesn't have input fields you fill out manually.

The one exception is approvals. When work is ready for review, you can approve or request changes — but even this happens in chat. The orchestrator presents you with a review card showing the diff, test results, and recordings. You tap approve or leave feedback right there in the conversation. The task board reflects the result, but the interaction happened in chat.

## Your Chat Is Your History

Because everything flows through the orchestrator, your chat becomes a complete record of everything that has happened. Requests you made. Plans the orchestrator created. Progress updates from sub-agents. Results delivered. Approvals given. Feedback provided.

You can scroll back through your conversation and see the full narrative: "Two weeks ago I asked for competitor research. The research agent found three interesting features. I approved one for implementation. The coding agent built it. The testing agent verified it. I approved the merge." All in one thread, all in your own words and the orchestrator's words. No jumping between dashboards and logs and task boards to reconstruct what happened.

## Agents Are Created Through Conversation

You don't navigate to an agent creation form. You say "I need an agent that monitors Hytale modding communities for popular mod requests." The orchestrator asks clarifying questions if needed: how often should it check, what sources should it monitor, should it create tasks automatically or just report findings? Then it sets up the agent with the right system prompt, tools, model, and schedule. The agent appears in the system, ready to work.

If you want to change an agent's behavior, you tell the orchestrator. "Make the Hytale research agent check daily instead of weekly." Done. No settings page, no edit form.

## Teams Are Pipelines With Persistent Roles

When the orchestrator plans a pipeline, it can assign agents from a standing team — a group of specialists that work together repeatedly on a domain. The "AgentStudio self-improvement team" always has the same research agent, coding agent, testing agent, and docs agent. They share context about the project, know the codebase conventions, and get better over time because the memory system captures their patterns.

Teams aren't managed through a UI. You say "I want a team dedicated to improving AgentStudio." The orchestrator builds it. You say "add a design agent to the team that generates wireframe options." The orchestrator updates it. The team page in the UI shows you who's on the team and what they've accomplished — but it's a window, not a control panel.

## Artifacts Are Living Apps

Artifacts are not every output an agent produces. Code diffs, research summaries, and task reports are just message content — they live in chat and on the task board where they belong.

Artifacts are apps. Small, interactive, persistent applications that live inside AgentStudio. A calorie tracker is an app. A budget dashboard is an app. A project status board with live data is an app. Each artifact has its own storage, its own state, its own UI.

The distinction is simple: if it just displays information once, it's a message. If it has state, persistence, and interactivity, it's an artifact. You wouldn't make an artifact out of a code snippet. You would make an artifact out of a dashboard that tracks your OpenRouter spending over time with charts that update every day.

Artifacts get updated through conversation. You tell the orchestrator "I had a chicken bowl, about 700 calories" and it pushes that data to your calorie tracker artifact. You can open the artifact from your library anytime and see your data, your trends, your progress. The artifact is alive — it grows and changes through conversation.

Think of them like widgets on a phone home screen, except each one was built by your AI through conversation, tailored exactly to what you need, and backed by its own little database.

---

## The Memory Palace

AgentStudio's memory system is inspired by the ancient method of loci — the memory palace technique where knowledge is organized spatially into an imaginary building. Instead of dumping memories into a flat vector store and hoping semantic search finds the right one, AgentStudio organizes everything you've ever discussed into a navigable structure of wings, rooms, halls, tunnels, closets, and drawers.

This isn't a cosmetic metaphor. Structured spatial retrieval consistently outperforms flat search by over 30%. When the orchestrator knows which wing and room to look in, it finds the right memory almost every time.

### The Structure

**Wings** are the top-level domains of your life. Each major person, project, or topic gets its own wing in the palace. You might have:

- A wing for AgentStudio (the platform itself)
- A wing for Brown & Root (your day job)
- A wing for your D&D campaign
- A wing for personal life (home, health, finances)
- A wing for each person you interact with frequently

Wings are created automatically as the system detects new domains in your conversations. You never manually create one.

**Rooms** are specific subjects within a wing. The AgentStudio wing has rooms for the auth system, the memory architecture, the artifact system, deployment, the orchestrator design. The Brown & Root wing has rooms for each project, each codebase, each team process. Rooms emerge naturally from conversation topics — the dream cycle detects when a new subject has accumulated enough context to warrant its own room.

**Halls** are memory types that exist in every wing, acting as corridors that categorize what kind of knowledge each memory represents:

- `hall_facts` — decisions made, choices locked in, concrete information
- `hall_events` — sessions, milestones, debugging moments, things that happened
- `hall_discoveries` — breakthroughs, new insights, things learned
- `hall_preferences` — habits, likes, opinions, ways of working
- `hall_advice` — recommendations, solutions, approaches that worked

When you say "we decided to use Drizzle instead of Prisma," that's a fact in the AgentStudio wing. When you say "I figured out the streaming bug was caused by a missing await," that's a discovery. The system categorizes automatically.

**Tunnels** are connections between wings. When the same topic appears in different domains, a tunnel links them. If both your Brown & Root wing and your AgentStudio wing have rooms about "auth patterns," a tunnel cross-references them. This means when you're working on auth in one project, the system can surface relevant decisions and patterns from the other without you asking.

**Closets** are summaries that point to the original content. They're the quick-access layer — concise descriptions that tell the system where to find the full context. When the orchestrator is assembling context for a new conversation, it reads closets first to figure out what's relevant, then pulls full content from drawers only when needed.

**Drawers** are the original verbatim content. Every conversation, every coding session, every agent run — the exact words are preserved. Nothing is ever summarized away or lost. Closets help find things fast, but drawers ensure you can always go back to the source.

### Why This Matters

The palace structure solves the biggest problem with AI memory: retrieval quality. A flat vector store with 10,000 memories returns fuzzy results because everything is searched against everything. The palace narrows the search space before semantic similarity even runs:

1. The orchestrator identifies the relevant wing (are we talking about work? AgentStudio? personal?)
2. It narrows to the relevant hall (is this about a fact? a preference? an event?)
3. It searches within the relevant rooms
4. Semantic similarity runs on a focused subset instead of the entire memory store

Each layer of narrowing improves recall dramatically. Wing filtering alone adds 12%. Wing + room adds 34%. By the time the system searches, it's looking in exactly the right place.

### The Dream Cycle Maintains the Palace

The dream cycle isn't just consolidation — it's the palace architect. During each cycle, the system:

**Builds new rooms** when it detects a topic has accumulated enough context to warrant its own space. Three conversations about "deployment pipeline" in the AgentStudio wing? That becomes a room.

**Creates tunnels** when it discovers the same concept appearing in different wings. You mentioned rate limiting in both your Brown & Root work and your AgentStudio project? A tunnel links those rooms.

**Updates closets** with fresh summaries as new content arrives in drawers. The closet for the "auth" room gets updated when new auth-related decisions are made.

**Resolves contradictions** when newer information conflicts with older memories. "We decided to use SQLite" gets superseded by "We switched to Postgres for pgvector support." The old fact is marked as historical, the new fact takes precedence, and a relation connects them so the reasoning chain is preserved.

**Prunes decayed memories** that haven't been accessed and have low importance scores. The forgetting curve ensures the palace stays clean and relevant. Important memories that are frequently accessed stay sharp. Irrelevant details naturally fade.

**Enriches the knowledge graph** by creating typed relations between memories — supports, contradicts, depends_on, part_of. This is the tunnel and hall infrastructure that makes cross-domain reasoning possible.

### The Memory Stack

Not all memory is loaded at once. The system uses a layered approach:

| Layer | What                                                        | Size        | When                   |
| ----- | ----------------------------------------------------------- | ----------- | ---------------------- |
| L0    | Identity — who is the user, core preferences                | ~50 tokens  | Always loaded          |
| L1    | Critical facts — active projects, key people, current goals | ~120 tokens | Always loaded          |
| L2    | Room recall — recent sessions, current topic context        | On demand   | When a topic comes up  |
| L3    | Deep search — semantic query across all closets and drawers | On demand   | When explicitly needed |

The orchestrator wakes up with L0 + L1 and already knows your world. It knows your name, your job, your active projects, your preferences. When you start talking about a specific topic, L2 kicks in and loads the relevant room context. If you ask about something from months ago, L3 does a deep search across the full palace.

This means the orchestrator is always contextually aware without burning thousands of tokens loading memories that aren't relevant to the current conversation.

### Every Agent Gets a Wing

Sub-agents don't share a flat memory space. Each specialist agent gets its own wing in the palace. The coding agent's wing accumulates patterns about codebases, debugging approaches, and conventions. The research agent's wing captures sources, findings, and evaluation criteria. The testing agent's wing remembers test patterns, failure modes, and coverage strategies.

When an agent is assigned a task, it loads context from its own wing plus the relevant project wing. This scoped retrieval means agents get exactly the right context without drowning in irrelevant memories from other domains.

### Memory Is Invisible

You never interact with the palace directly. You don't create wings, name rooms, or organize memories. The orchestrator and the dream cycle handle all of that automatically. The memory explorer in the UI is a read-only window — you can browse the palace structure, see what's in each wing and room, check importance scores and access patterns. But you never edit it manually. If something is wrong, you tell the orchestrator: "that's outdated, we switched to Postgres." The orchestrator updates the memory, and the dream cycle cleans up the relations.

The palace exists to make the AI smarter. Its complexity is hidden. All you experience is an AI that remembers everything, finds the right context instantly, and gets better the more you use it.

---

## The Endgame

The endgame is never having to write, debug, or test code yourself. You describe what you want. The orchestrator plans it. Specialist agents build it, test it, and record proof that it works. You review finished products and approve them with full confidence.

AgentStudio manages its own codebase. It researches its own competitors. It implements its own features. It tests its own changes. It manages its own GitHub releases. You are the CEO of a one-person AI company, and your only job is deciding what matters and saying yes or no to finished work.

The memory palace grows with every interaction, every decision, every project. Six months from now, AgentStudio knows your entire professional history, your coding patterns, your design preferences, your team's conventions, and the reasoning behind every decision you've ever made. It doesn't just remember facts — it understands context, connections, and consequences.

The platform doesn't just use AI. The platform is AI. Conversation is the interface. Agents are the workforce. The palace is the institutional knowledge. And the orchestrator ties it all together into a system that gets smarter and more capable every single day.
