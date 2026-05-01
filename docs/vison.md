# AgentStudio — Vision

## What AgentStudio Is

AgentStudio is a self-hosted AI platform where conversation is the only interface. You talk to one orchestrator, and it runs your entire digital life — coding, research, monitoring, planning, creating. You never fill out a form, configure a setting through a UI, or manually assign a task. You just talk, and the system figures out the rest.

Everything flows through the orchestrator. Everything reports back to the orchestrator. Your chat is the single source of truth for every action taken on your behalf.

## The Orchestrator

The orchestrator is not an agent. It is the platform's brain. It sits above every agent, every task, every project, and every tool. It knows your preferences, your active projects, your goals, and the current state of every running workflow. When you speak to AgentStudio, you are speaking to the orchestrator.

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

AgentStudio has pages — a task board, a cost dashboard, agent profiles, project views. These are read-only windows into what's happening. You look at the Kanban board to see where tasks stand. You look at the cost dashboard to understand spending.

But you never create or edit anything through these views. Every action that changes state flows through the orchestrator via conversation. The task board doesn't have a "new task" button. The agent page doesn't have a configuration form. The settings page doesn't have input fields you fill out manually.

The one exception is approvals. When work is ready for review, you can approve or request changes — but even this happens in chat. The orchestrator presents you with a review card showing the diff, test results, and recordings. You tap approve or leave feedback right there in the conversation. The task board reflects the result, but the interaction happened in chat.

## Your Chat Is Your History

Because everything flows through the orchestrator, your chat becomes a complete record of everything that has happened. Requests you made. Plans the orchestrator created. Progress updates from sub-agents. Results delivered. Approvals given. Feedback provided.

You can scroll back through your conversation and see the full narrative: "Two weeks ago I asked for competitor research. The research agent found three interesting features. I approved one for implementation. The coding agent built it. The testing agent verified it. I approved the merge." All in one thread, all in your own words and the orchestrator's words. No jumping between dashboards and logs and task boards to reconstruct what happened.

## Agents Are Created Through Conversation

You don't navigate to an agent creation form. You say "I need an agent that monitors Hytale modding communities for popular mod requests." The orchestrator asks clarifying questions if needed: how often should it check, what sources should it monitor, should it create tasks automatically or just report findings? Then it sets up the agent with the right system prompt, tools, model, and schedule. The agent appears in the system, ready to work.

If you want to change an agent's behavior, you tell the orchestrator. "Make the Hytale research agent check daily instead of weekly." Done. No settings page, no edit form.

## Teams Are Pipelines With Persistent Roles

When the orchestrator plans a pipeline, it can assign agents from a standing team — a group of specialists that work together repeatedly on a domain. The "AgentStudio self-improvement team" always has the same research agent, coding agent, testing agent, and docs agent. They share context about the project and know the codebase conventions.

Teams aren't managed through a UI. You say "I want a team dedicated to improving AgentStudio." The orchestrator builds it. You say "add a design agent to the team that generates wireframe options." The orchestrator updates it. The team page in the UI shows you who's on the team and what they've accomplished — but it's a window, not a control panel.

## Artifacts Are Living Apps

Artifacts are not every output an agent produces. Code diffs, research summaries, and task reports are just message content — they live in chat and on the task board where they belong.

Artifacts are apps. Small, interactive, persistent applications that live inside AgentStudio. A calorie tracker is an app. A budget dashboard is an app. A project status board with live data is an app. Each artifact has its own storage, its own state, its own UI.

The distinction is simple: if it just displays information once, it's a message. If it has state, persistence, and interactivity, it's an artifact. You wouldn't make an artifact out of a code snippet. You would make an artifact out of a dashboard that tracks your OpenRouter spending over time with charts that update every day.

Artifacts get updated through conversation. You tell the orchestrator "I had a chicken bowl, about 700 calories" and it pushes that data to your calorie tracker artifact. You can open the artifact from your library anytime and see your data, your trends, your progress. The artifact is alive — it grows and changes through conversation.

Think of them like widgets on a phone home screen, except each one was built by your AI through conversation, tailored exactly to what you need, and backed by its own little database.

## The Endgame

The endgame is never having to write, debug, or test code yourself. You describe what you want. The orchestrator plans it. Specialist agents build it, test it, and record proof that it works. You review finished products and approve them with full confidence.

AgentStudio manages its own codebase. It researches its own competitors. It implements its own features. It tests its own changes. It manages its own GitHub releases. You are the CEO of a one-person AI company, and your only job is deciding what matters and saying yes or no to finished work.

Over time, AgentStudio can reflect your professional history, your coding patterns, your design preferences, your team's conventions, and the reasoning behind key decisions.

The platform doesn't just use AI. The platform is AI. Conversation is the interface. Agents are the workforce. And the orchestrator ties it all together into a system that gets smarter and more capable every single day.
