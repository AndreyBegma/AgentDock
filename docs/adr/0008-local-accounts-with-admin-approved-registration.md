# ADR-0008: Local accounts with admin-approved registration

Status: accepted · Date: 2026-10-07

## Context

Several people may use one AgentDock, but agents run on the owner's subscriptions and machines.

## Decision

First admin created by CLI. Email + password, server-side cookie sessions. Registration is closed by default and toggled by an admin. A registration creates a `pending` user; an admin approves (assigning admin / operator / viewer) or rejects. Access to a project requires membership. OAuth is deferred. 2FA was deferred too; [ADR-0081](0081-totp-two-factor-sign-in-with-hashed-recovery-codes.md) adds TOTP two-factor sign-in.

## Consequences

Full control over who reaches the runners. Rejected for now: GitHub OAuth login, SSO.
