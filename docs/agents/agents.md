# Agents

This page describes agents in plain English. For the full data model and design notes, see [spec.md](spec.md). For the build history, see [plan.md](plan.md).

## Overview

An agent is a named AI persona: a name, a role, a system prompt (its instructions), a model, and a set of tools it may use. Every conversation is bound to one agent. The person who runs this AgentStudio instance sees all agents at `/agents` and can open any one at `/agents/[id]`.

There are three kinds of agent:

| Kind | What it is | Examples |
| ---- | ---------- | -------- |
| Built-in | Shipped with the app. Created again at every startup if missing. | Chat, Research, Plan, Autonomous |
| Custom | Created by the user, usually by asking the assistant to make one. | "Reviewer", "Release notes writer" |
| Evaluator | Grades other agents' runs after they finish. The runtime starts it, not the user. | Default Evaluator |

## Key concepts

### Delegation

A built-in agent can hand part of a task to a custom agent. The built-in agent is told which agents it can hand work to, and it asks for one by name. At most 12 custom agents are offered at once, newest first. Built-in agents and evaluators are never offered.

### Status: Available or Paused

Every agent is either **Available** or **Paused**.

| Status | Offered for delegation | Run by its automations and monitors | Can be chatted with directly |
| ------ | ---------------------- | ----------------------------------- | ---------------------------- |
| Available | Yes (custom agents only) | Yes | Yes |
| Paused | No | No — each run is skipped and recorded | Yes |

Pausing is a way to bench an agent without deleting it. It is useful because only 12 agents are offered for delegation, and each one offered adds to the cost of every request.

The database stores three values: `active`, `idle` and `paused`. `active` and `idle` mean the same thing and both show as Available. New agents start as `idle`; resuming an agent writes `active`.

## User flows

### Pause an agent

1. Open `/agents`, or open the agent's own page at `/agents/[id]`.
2. Press **Pause** on the agent's card, or in the page header on its own page.
3. The status changes to **Paused**. The agent's page explains what that means.
4. The change is recorded in the audit trail (`/audit`) as "Agent status changed", with who made it.

From then on:

- A built-in agent that delegates work no longer sees this agent.
- Each automation assigned to it is skipped when it comes due. The run history on `/automations` shows the skipped run as **blocked**, with the reason "agent … is paused". The schedule moves on to the next time as usual. "Run now" is skipped the same way.
- A monitor that would start a conversation with it does not. The monitor opens a review item instead, so what it saw is not lost.
- You can still open a chat with it and talk to it directly.

The automation cards on `/automations` show "(paused)" next to the agent's name, and the agent picker on the new-automation form marks it the same way.

### Resume an agent

1. Press **Resume** on the agent's card or page.
2. The status changes back to **Available** and the change is recorded in the audit trail.
3. Its automations run again from their next scheduled time. Skipped runs are not made up.

The assistant can also pause and resume agents itself with its `pause_agent` and `resume_agent` tools. The same rules apply, and the audit trail shows no person for those changes.

## Roles & permissions

AgentStudio has a single owner and no admin tier. The owner can view every agent, pause and resume custom agents, and edit an agent's model, system prompt and hooks.

Some agents cannot be paused:

- **Built-in agents** are never offered for delegation, because they are the ones doing the delegating. For them, "paused" would only mean "its automations stop", which is a different promise from the one the button makes. The Chat agent is also the default for new conversations. To stop an automation that uses a built-in agent, disable the automation.
- **Evaluators** grade runs whatever their status, and are never offered for delegation. A Pause button would promise something it does not do.

These agents show a **Built-in** or **Evaluator** label and have no Pause button. The server refuses the request as well, so the rule holds even for a request made outside the page. A built-in agent that was paused before this rule existed can still be resumed.

## Built-in agents and their tools

| Agent | Tools |
| ----- | ----- |
| Chat | All tools |
| Autonomous | All tools |
| Research | Read-only tools, plus `Write` and `request_plan_approval` |
| Plan | Read-only tools, plus `Write` and `request_plan_approval` |
| Custom agent | All tools, unless its settings list the only tools it may use |

Research and Plan share one list of allowed tools. That list includes `Write`, and this is deliberate (decided in issue #67). Both agents work the same way: they write their plan to a markdown file (`RESEARCH-PLAN.md` or `PLAN.md`), then ask the user to approve it with `request_plan_approval`. That tool reads the plan from the file, so Research needs `Write` as much as Plan does. Taking it away would break Research's only workflow.

Research and Plan cannot run shell commands, edit files in place, push code or open pull requests. Every tool call they make is still checked against the workspace and the approval settings.

## Integrations

- **Claude Agent SDK.** The custom agents a run may delegate to are passed to the SDK as its list of agents. The SDK describes each one in its delegation tool, `Agent`. The built-in agents' instructions point there instead of keeping a list of their own, so the two cannot disagree.
- **Automations and monitors.** Both check the agent's status before running it. See [../automations/spec.md](../automations/spec.md) and [../monitors/spec.md](../monitors/spec.md).
- **Audit trail.** Every change of status is recorded as `agent.status.changed`.

## Business rules

- Paused is the only status that changes behaviour. `active` and `idle` are both Available.
- Only custom agents can be paused. Any paused agent can be resumed.
- Resuming an agent that is not paused changes nothing and records nothing.
- A paused agent is not offered for delegation, and automations and monitors do not run it. Direct chats are not affected.
- An automation skipped because its agent is paused is not a failure. It does not count toward the five failures that switch an automation off, and it does not reset that count.
- A skipped scheduled run moves the schedule on. A skipped "Run now" or monitor-started run leaves it where it was.
- An automation with no agent is never affected by any agent's status.
