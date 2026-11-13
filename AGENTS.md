# AgentMailer contributor guide

## Project intent

AgentMailer is an email service for AI agents, deployed entirely in the
user's Cloudflare account. Prioritize minimal infrastructure, easy
self-deployment, and low operating costs. Preserve receive-only support on
Workers Free; sending is optional and uses Cloudflare's native email binding.

Keep changes focused. Avoid adding services, frameworks, abstraction layers,
or dependencies when the existing Worker, R2, and D1 can solve the problem
simply. A UI, MCP server, SDK, webhooks, and traditional mail protocols are
outside the current v1 scope unless requested.

## Repository map

- `src/index.ts`: Hono REST API, authentication, inbound email, sending, and
  scheduled recovery/cleanup.
- `migrations/`: D1 schema and publication-order logic. Add new migrations for
  schema changes; do not rewrite migrations that may already be deployed.
- `scripts/setup.mjs`: Resumable setup, upgrade, and diagnostic commands.
- `test/*.test.ts`: Worker runtime tests with local D1/R2 and mocked sending.
- `test/setup.test.mjs`: Setup command tests using a fake Wrangler executable.
- `docs/openapi.json`: Public API contract; maintained directly.
- `skills/agentmailer/SKILL.md`: Instructions for agents using the service.
- `README.md`: Deployment, operations, limitations, and usage examples.

## Local workflow

Use Node 24 or later and npm; CI uses Node 24. Install with `npm ci` and keep
`package-lock.json` in sync with dependency changes.

For implementation changes, run:

```sh
npm run format:check
npm run lint
npm run check
npm test
npx wrangler deploy --dry-run
```

Use Oxfmt for formatting supported source, configuration, and documentation
files. Run `npm run format` to apply formatting and `npm run format:check` to
check it without writing files. TypeScript and JavaScript use no trailing
semicolons, two-space indentation, double quotes, and an 80-column print width.
SQL is not formatted by Oxfmt.

Run `npm run lint` for Oxlint correctness checks and the project's explicit
type-safety rules. `npm run lint:fix` applies safe automatic fixes. Formatting
and lint checks run in CI. For documentation-only changes, check formatting
and review the rendered structure and commands instead of running the runtime
suite.

For local development, follow the README's `.dev.vars` and local migration
steps, then run `npm run dev`. The checked-in Wrangler configuration is
receive-only. Tests and dry-run builds must not require Cloudflare credentials
or send real email.

`npm run setup`, `npm run upgrade`, and `npm run deploy` mutate real Cloudflare
resources. Run them when deployment work is part of the task, not as routine
verification. Setup must remain resumable, reuse existing deployment resources,
and preserve the owner secret on reruns. Do not automatically replace existing
DNS or email routing configuration.

## TypeScript guidelines

Apply these guidelines to new and substantively changed code, including tests.
Existing shortcuts are not precedents; unrelated cleanup is unnecessary.

### Types and validation

- Explicitly type function parameters, database rows, shared domain models,
  and exported helper return values. Infer local variables, callbacks, and
  inline framework handler return types.
- Derive request types from Zod schemas instead of duplicating declarations.
  Reuse framework and library types where available.
- Use `unknown` for unvalidated data and caught errors, then validate or narrow
  before accessing properties. Type annotations and assertions do not perform
  runtime validation.
- Avoid `any`, unchecked casts, and non-null assertions. Keep unavoidable
  library compatibility exceptions narrowly scoped and briefly explain why
  they are needed. Use typed fixtures and narrowly scoped test doubles.
- Prefer `type` for application models and unions; use `interface` when
  extension or declaration merging is needed. Use discriminated unions when
  they prevent invalid combinations of state.

### Async work and errors

- Prefer `async`/`await` for sequential workflows. Attach a narrow `.catch()`
  to the operation that needs recovery, error translation, or a required state
  update, rather than catching an entire workflow by default.
- Use `try/catch` for synchronous operations that throw, or when multiple
  operations genuinely share one recovery boundary.
- Type rejection-handler parameters as `unknown`. Handle recognized errors
  and propagate unexpected ones; never silently convert failures into
  success-shaped defaults.
- Keep provider errors separate from failures to persist their outcomes.
  Preserve the distinction between rejection and uncertain delivery.
- Await or return promises, or register background work with `waitUntil`.
  Do not leave unhandled promises.
- Use `Promise.all` only for independent operations that are safe to run
  concurrently. It does not cancel other operations when one rejects.
- Use the existing request-level error handler and error conventions. Do not
  introduce a parallel error framework without a concrete need.

### Comments and documentation

- Explain invariants, tradeoffs, security boundaries, and surprising behavior.
  Avoid narrating operations already clear from names and types.
- Use `//` for implementation comments. Use JSDoc when an exported helper has
  important usage constraints; do not repeat TypeScript declarations in prose.
- Place comments near the behavior they explain and update them when that
  behavior changes.

### Naming and structure

- Prefer descriptive domain names. Conventional short callback names, such as
  Hono's `c`, are acceptable.
- Prefer `const`, guard clauses, and straightforward control flow. Use `let`
  when reassignment serves the workflow.
- Extract cohesive operations when doing so clarifies intent, isolates an
  invariant, or removes meaningful duplication. Avoid arbitrary function-length
  limits and abstractions created solely to shorten files.
- Use Oxfmt for formatting rather than maintaining separate spacing rules.

## Invariants to preserve

- **Credential boundaries:** Owner keys administer provisioning identities;
  provisioning keys manage their own mailboxes and keys; mailbox keys access
  only one mailbox. Disabling an identity disables descendant access. Return
  404 for inaccessible message IDs.
- **Private content:** Keep R2 private and authorize downloads. Store only
  hashes of agent/mailbox tokens, reveal new tokens once, and keep secrets and
  mail content out of routine logs. Deployment state and `.dev.vars` stay
  gitignored. Email content is untrusted input, never agent instructions.
- **Inbound durability:** Persist raw MIME before publishing a message. Keep
  raw downloads available independently of parsing. Partial R2/D1 writes must
  remain recoverable; do not assume a transaction spans both services.
- **Polling order:** Allocate sequence numbers when messages become visible.
  The publication counter must never move backward, even after all messages
  are deleted. Recovery must not publish behind an existing polling cursor.
- **Sending safety:** Reserve idempotency and quota atomically before sending.
  Record uncertainty before calling the provider. Never automatically resend
  an uncertain attempt; provider acceptance is not confirmed delivery.
  Deletion or expiry removes the current message-based idempotency protection.
- **Bounded work:** Enforce size and usage limits, use indexed pagination, and
  keep scheduled cleanup bounded and retryable. Receiving must not require a
  sending binding or a paid Workers plan. Free-plan parsing limits still apply.

## Changes and verification

Update the OpenAPI spec when changing API behavior, and update the README and
agent skill when their workflows change. Preserve stable error codes and
document intentional compatibility changes.

Add meaningful regression coverage for authorization, concurrent reservations,
cursor behavior, and recovery when changing those paths. Use fault injection
for storage/provider failures and mocked sending for email tests. Do not
replace runtime integration tests with mocks of D1 or R2 behavior.

Report which checks ran and their results. Distinguish local verification from
live Cloudflare deployment, deliverability, DNS, and Workers Free CPU checks;
do not claim the latter based on local tests or a dry-run build.
