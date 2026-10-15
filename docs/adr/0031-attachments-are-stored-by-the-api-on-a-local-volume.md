# ADR-0031: Attachments are stored by the API on a local volume and reach the card worker through the runner

Status: accepted · Date: 2026-10-15 ·
Issue: [#309](https://github.com/AndreyBegma/AgentDock/issues/309)

## Context

People want to attach files and screenshots to a board card, and the agent that
works the card must see them. AgentDock stores no files today: every byte it
keeps is a database row. It is self-hosted on one host: compose with PostgreSQL
and Redis, and staging on the agent host behind a tunnel
([ADR-0016](0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md)).
The control plane never reads a project's filesystem
([ADR-0001](0001-control-plane-and-per-machine-runner.md)), and the
runner accepts typed commands only
([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)).

## Decision

1. **The API stores attachment bytes on a local directory** (`ATTACHMENTS_DIR`),
   which compose mounts as a named volume. The database holds the metadata
   (`attachments` table): name, MIME type, size, SHA-256, owner. All access goes
   through one `AttachmentStore` port with a filesystem implementation, so an
   S3-compatible store can be added later as a second implementation without
   changing callers.
2. **Attachments belong to a board card**, either to the card itself or to one
   round's feedback. Inbox cards take none until accepted. Plan tasks take none:
   they are read-only on the Board ([ADR-0028](0028-one-work-surface-for-cards-and-plan-tasks.md)).
3. **Only members of the card's project read them, through the API.** There are
   no public or signed URLs for browsers. The browser reads
   `/projects/:projectId/attachments/:id/content` with its session cookie. Every
   response carries `X-Content-Type-Options: nosniff`. Only the raster images
   allowed by the upload list are served inline; everything else is served as
   `Content-Disposition: attachment` with a sandboxing CSP.
4. **The runner fetches them, the API never pushes files over the socket.**
   `card.run` lists the attachments of the card by id and SHA-256. Before it
   starts or resumes the worker, the runner downloads each file over HTTPS from
   `/runner/attachments/:id`, authenticated with its own runner token. It
   verifies the size and the hash and writes the files under
   `.agentdock/attachments/` in the card's worktree. That path is git-excluded.
   The API serves a file only to the runner that owns the card's project
   (`Project.runnerId`).
5. **Upload types are an allowlist**, checked by content signature, not by the
   name or the browser's MIME type:
   - images: PNG, JPEG, GIF, WebP;
   - PDF;
   - plain text: `.txt`, `.md`, `.log`, `.csv`, `.json`, `.diff`, `.patch`.

   SVG, HTML and archives are refused.
6. **Attachments are not session content** ([ADR-0021](0021-session-content-is-opt-in-per-project.md)).
   A person adds them on purpose. They live as long as their card, a content
   purge does not remove them, and capture and text normalization never read
   them ([ADR-0026](0026-card-capture-reads-opt-in-session-content.md),
   [ADR-0027](0027-stored-text-is-normalized-to-english-on-the-runner.md)).

## Consequences

- The deployment gains a volume that must be backed up with the database. The
  database alone no longer restores everything.
- Bytes travel API → runner over HTTPS once per change. A card's files are
  bounded (25 MiB each, 20 per card), so the cost is small.
- No server-side scan for secrets or malware. The upload UI says plainly that
  every project member can read an attachment. The type allowlist and inline
  serving of raster images only are the defence.
- Rejected:
  - **MinIO / S3 in compose.** A second stateful service and credentials for a
    one-host install. The store port keeps the option open.
  - **Bytes in PostgreSQL.** Bloats backups and the WAL, and streams poorly.
  - **Files over the runner socket.** The socket carries small typed frames, and
    its payload cap is sized for events.
  - **Signed public URLs.** Links that leak outlive membership.
