# AgentMailer

Self-hosted email for AI agents, entirely in your Cloudflare account. MIT licensed.
One TypeScript Worker, a private R2 bucket for content, and D1 for credentials and message metadata. No hosted control plane or external email provider.

## Deploy

Requires Node 24+, npm, a Cloudflare account, an activated R2 subscription, and a domain using Cloudflare DNS. Use a dedicated subdomain such as `agents.example.com` to avoid replacing existing mail service.

```sh
npm ci
npm run setup
```

The wizard logs into Wrangler, asks for your account ID and mail domain, creates D1/R2, applies migrations, installs an owner secret, and deploys. Save the displayed owner token in a password manager. It is not saved locally. `.deployment.json` and `wrangler.deploy.json` hold deployment state and are gitignored. Preserve them to resume setup and upgrade; rerunning setup reuses resources. If interrupted while creating a bucket, verify ownership before allowing reuse. Saved settings and Wrangler JSON responses are validated before use, and resume state is saved atomically. Invalid state stops setup rather than starting a new deployment. Setup does not change DNS or routing rules.

In Cloudflare Email Service:

1. Enable Email Routing for the selected domain/subdomain; review MX/SPF records and existing routing before making changes.
2. Route catch-all to the deployed Worker. Unknown or disabled mailbox addresses are rejected by the application.
3. For sending, enable Workers Paid and onboard the same domain in Email Sending; complete DNS verification.
4. Visit the Worker URL printed by Wrangler at `/health`. Create a mailbox below, send it an external test email, and verify receipt. If sending is enabled, send and reply to an external address and verify threading and attachments.

## Configuration

Edit `config.json`, created by setup, then inspect and deploy:

```sh
npm run config
npm run deploy
```

| Setting                              | Default             | Meaning                                                                                      |
| ------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `mailDomain`                         | Chosen during setup | Deployment domain; changing an existing domain requires a separate migration                 |
| `sendingEnabled`                     | `false`             | Generate the optional sending binding; sending requires Workers Paid and domain onboarding   |
| `retentionDays`                      | `0`                 | Forever; positive integer days expire existing incoming and outgoing messages during cleanup |
| `maxMessageMiB`                      | `5`                 | Integer 1–5; inbound MIME size and outbound JSON plus 16 KiB allowance                       |
| `defaults.mailboxesPerIdentity`      | `10`                | Active mailboxes per new provisioning identity; range 1–1,000                                |
| `defaults.dailyRecipientsPerMailbox` | `100`               | Recipient deliveries per mailbox per UTC day for new identities; range 1–100,000             |

Omitted settings use these defaults. Unknown fields and invalid values stop deployment.
Quota defaults are copied into new identities; existing limits remain unchanged.
Owners can override quotas when creating an identity. Lower retention applies to
existing messages and permanently deletes content, metadata, and message-based
idempotency protection. Cleanup is batched, so expiry is not instantaneous.

`config.json` is the human-editable source of policy.
`.deployment.json` holds machine-managed resource IDs and resume progress.
`wrangler.deploy.json` is generated: direct edits are overwritten on deployment.
All three files are gitignored. Keep backups of settings and deployment state.
Secrets remain in Wrangler; local `.dev.vars` is for development secrets only.

`npm run deploy` and `npm run upgrade` both validate settings, regenerate config,
apply migrations, and redeploy existing resources. Initial provisioning uses
`npm run setup`. Receive-only deployments omit the sending binding.

`npm run config` displays effective policy locally without credentials or remote
calls. If `config.json` is missing, it exits with setup or restore guidance. `npm run doctor` checks account authentication and database access and lists
remaining dashboard checks. Local development uses the same policy defaults;
Wrangler variable overrides are validated at runtime. Tests and build checks do
not create production resources.

## Credentials and usage

Set `BASE` to the deployed HTTPS URL and set `OWNER_TOKEN` privately in your shell. Avoid shell tracing and storing credentials in scripts.

```sh
curl "$BASE/agents" -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"assistant","mailboxLimit":10,"dailyLimit":100}'
```

Save the returned provisioning `token` as `AGENT_TOKEN`. It manages only its own mailboxes and their keys, and cannot read or send mail directly.

```sh
curl "$BASE/mailboxes" -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"assistant"}'
```

Save the returned `token` as `MAILBOX_TOKEN`. Keys are returned once and stored only as hashes. The response also includes mailbox `id`, `address`, and `keyId`. If creation was interrupted after the mailbox was inserted, list mailboxes and issue a replacement key using its ID.

```sh
curl "$BASE/messages?after=0&limit=50" -H "Authorization: Bearer $MAILBOX_TOKEN"
curl "$BASE/messages/MESSAGE_ID" -H "Authorization: Bearer $MAILBOX_TOKEN"
curl "$BASE/send" -H "Authorization: Bearer $MAILBOX_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: task-123-message-1' \
  -d '{"to":["person@example.net"],"subject":"Task update","text":"The task is complete."}'
```

API routes have no version or administration prefix. Upgrading from the previous URLs requires changing `/v1/admin/agents` to `/agents` and removing `/v1` from other calls; old URLs return 404.

All endpoints and request fields are specified in OpenAPI at `GET $BASE/openapi.json`, available without credentials and generated from the deployed routes and shared schemas. Install [the agent skill](skills/agentmailer/SKILL.md) in your agent's skill directory and provide its base URL and credentials through your secret manager.

Polling returns metadata in ascending sequence order. Follow `nextCursor` until empty, then wait at least 60 seconds with backoff. Persist the cursor only after processing the page; make processing safe to repeat. Read state is shared per mailbox and changes only through PATCH. Prefer polling without filters to avoid missing later read-state changes. The cursor tracks publication, not modifications; this is not a change feed.

Message responses include bodies and attachment metadata; download bytes via the attachment endpoint. Incoming originals are available at `/raw`; outgoing content is stored as JSON, not a reconstructed MIME message. Outgoing attachments are base64. Sender display names use `name`; recipient lists contain email strings. Replies target Reply-To or From, with threading headers; reply-all is not supported.

## Reliability and limits

- Configured message limit defaults to 5 MiB (maximum 5 MiB). Outbound JSON plus a 16 KiB envelope/header allowance must fit it. Fixed safety bounds: 8 MiB HTTP request body, 50 recipients, 32 outgoing attachments, and 100 results per polling page (default 50).
- Raw mail is stored before publication. Incoming content is deduplicated per mailbox; deliberately resending identical bytes is treated as a duplicate.
- Bodies and attachments are parsed on demand and cached. Parsing can exceed Workers Free CPU limits even below 5 MiB; raw downloads remain available. Large-message parsing on Free requires live validation and is not guaranteed.
- Pending storage writes are reconciled every 15 minutes after a one-hour grace period. Failed pending writes without content are removed. Incoming handler errors are surfaced to Cloudflare; do not assume the platform guarantees retry or exactly-once delivery.
- Sending records provider acceptance, known rejection, or uncertain outcome. **Never blindly retry an uncertain send with a new idempotency key.** Reusing the same key returns the existing attempt; changed content returns 409. Idempotency lasts while the message record exists. Deleting/expiring it removes that protection.
- Every accepted or uncertain recipient attempt consumes daily quota; known failures also consume reserved quota conservatively. There is no automatic resend. Daily limits reset at UTC midnight.
- Default limits are 10 active mailboxes per provisioning identity and 100 recipient deliveries per mailbox daily. Owner supplies overrides when creating an identity. Revoking a provisioning identity disables all descendant access and incoming delivery. Disabling a mailbox preserves its data and reserves its address.
- Retention defaults to forever (`RETENTION_DAYS=0`); positive days expire all message content and metadata in bounded batches. DELETE is permanent, with retryable cleanup. Heavy expiry backlogs take multiple runs. Bodies are hidden as soon as deletion begins.
- Routine requests do not log credentials, content, or recipient data. Cloudflare platform logs may still contain platform-level errors; configure their access and retention appropriately.

## Costs

Email Routing itself is free. Worker execution, D1, R2 storage and operations have usage allowances and possible charges. R2 requires activation even when usage fits its free tier. Sending to arbitrary recipients requires Workers Paid; Cloudflare currently includes 3,000 sends/month, then charges $0.35 per 1,000. Account quotas and sending reputation limits also apply. Check current [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). No zero-cost guarantee at arbitrary volume.

## Development and verification

```sh
printf 'OWNER_TOKEN=local-development-only\n' > .dev.vars
npx wrangler d1 migrations apply agentmailer --local
npm run dev
npm run format:check
npm run lint
npm run check
npm test
npx wrangler deploy --dry-run
```

Use `npm run format` to apply Oxfmt formatting (including semicolon-free TypeScript and JavaScript), and `npm run lint:fix` for safe Oxlint fixes. CI checks formatting and linting alongside types and tests.

Local dev uses isolated local D1/R2. Receive-only is the checked-in default; sending tests use a mock binding. Runtime tests run inside workerd with real local D1/R2. Live deployment, delivery, DNS, and Free-plan CPU validation require a Cloudflare account and external mailbox; local tests do not establish these guarantees.

## Export and recovery

Export metadata with `npx wrangler d1 export DATABASE_NAME --remote --output backup.sql --config wrangler.deploy.json`. Export the private bucket with an S3-compatible tool such as rclone using separately issued, least-privilege R2 credentials. Export both together during a maintenance window for consistency; message rows reference R2 keys. Backups contain sensitive mail and hashed credentials. Restore D1 and R2 into a deployment with the same domain and bindings, then issue fresh credentials and verify routing. Rotate the owner token with `npx wrangler secret put OWNER_TOKEN --config wrangler.deploy.json`. Rotate mailbox keys by issuing a replacement, switching the agent, then deleting the old key. Disabled provisioning identities cannot be reenabled; create a new identity.

This service does not include webmail, full-text search, IMAP/POP, campaigns, forwarding, automatic replies, delivery/bounce tracking, or webhook delivery.
