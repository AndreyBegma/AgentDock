# ADR-0005: Drive the cs-orchestrator skill, do not reimplement it

Status: accepted · Date: 2026-10-07

## Context

The orchestrator's logic — readiness, model choice, fences, merging, resuming — lives in the skill and its scripts and evolves there.

## Decision

AgentDock starts the orchestrator as a session (through a runtime profile) running `/code-sentinel:orchestrator`, observes it, and sends it the same inputs a person would. Control that bypasses it (stop a slot, message a worker) uses the same mechanisms the skill uses (`tmux kill-session`, `.orchestrator-msg.md` + send-keys) and is recorded as an event so the orchestrator sees it on its next wake.

## Consequences

One brain. AgentDock cannot schedule more cleverly than the skill does; improvements go into the skill.
