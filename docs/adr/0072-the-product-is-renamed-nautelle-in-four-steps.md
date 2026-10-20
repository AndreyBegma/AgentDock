# ADR-0072: The product is renamed Nautelle, in four steps

Status: accepted · Date: 2026-10-20 ·
Card: C-295 ·
Spec: [`docs/specs/card-295-rename-to-nautelle-brand-ui-text-and-doc.md`](../specs/card-295-rename-to-nautelle-brand-ui-text-and-doc.md)

## Context

The person decided on 2026-10-20 to rename the product from **AgentDock** to
**Nautelle**. The old name appears about 5,000 times in 1,800 files: in text
people read (the web app, Telegram and GitHub messages, the docs), in code
identifiers and package names (`@agentdock/*`, `AgentDock` classes), in the
runner and its protocol (`agentdock-runner`, `X-AgentDock-*` webhook headers,
the `AgentDock-Card` pull request marker, `AGENTDOCK_*` variables) and in the
infrastructure (the GitHub repository, images, hosts, databases).

A single change would touch every open pull request at once, and the protocol
and infrastructure parts need a runner release and a deploy of their own.

## Decision

1. **Four cards, in this order, each only when no other card is open.**
   1. *Brand* (C-295, this ADR): every user-visible "AgentDock" becomes
      "Nautelle" — page titles, the wordmark, the placeholder mark (a
      sailboat on the tile, until the person sends a logo), the PWA manifest,
      the sign-in and onboarding text, the messages the API sends to Telegram,
      GitHub and webhooks, the prompts the API gives agents, the plugin's
      descriptions, the README and `docs/**`, and `CLAUDE.md`.
   2. *Code identifiers*: package names, classes, components and modules,
      by codemod. It conflicts with every open pull request, hence the rule.
   3. *Runner and protocol*: the runner's binary, package and messages, the
      `X-AgentDock-*` headers, the `AgentDock-Card` marker, the `via
      AgentDock` reply header and the `AGENTDOCK_*` variables, with a window
      in which the API and the runner accept both names.
   4. *Infrastructure*: the GitHub repository, images, hosts, databases and
      CI. No fallback `AgentDock` repository is created: GitHub redirects the
      old name only while no repository takes it.
2. **History is not rewritten.** ADR files keep their names and their text;
   this ADR records the rename for all of them. Release notes in
   `docs/releases/` keep the name the release shipped under. The spec of this
   card keeps the old name where it describes the rename.
3. **What the brand step leaves alone.** Code identifiers, package names,
   environment variables, paths, URLs, the webhook headers and User-Agent,
   and the pull request marker stay until their own card; so do the runner's
   texts.
4. **A check keeps the brand from coming back.** `scripts/check-brand.ts`
   fails `bun run check` when the API's or the shared package's sources say
   "AgentDock", and fails CI's `build` step when the built web app serves it
   (`--web`). Only the names of decision 3 are allowed.

## Consequences

- People see Nautelle everywhere they read the product, while the code, the
  protocol and the deployment still say AgentDock until steps 2–4 land.
- The card worker's prompt moves to version 20.
- The checks' allowlist shrinks as each later step renames its part; the last
  step removes it.
