import { Hono, type Context } from "hono"
import PostalMime, { type Email } from "postal-mime"
import { z } from "zod"
import type { ContentfulStatusCode } from "hono/utils/http-status"
export type Env = {
  DB: D1Database
  MAIL: R2Bucket
  EMAIL?: SendEmail
  OWNER_TOKEN: string
  MAIL_DOMAIN: string
  RETENTION_DAYS: string
  MAILBOX_LIMIT: string
  DAILY_LIMIT: string
}
type Principal = { kind: "owner" | "agent" | "mailbox"; id: string }
type AppEnvironment = { Bindings: Env; Variables: { principal: Principal } }
type AppContext = Context<AppEnvironment>
type AgentRow = {
  id: string
  name: string
  disabled: number
  mailbox_limit: number
  daily_limit: number
}
type MailboxRow = {
  id: string
  agent: string
  address: string
  disabled: number
}
type MessageStatus =
  | "pending"
  | "ready"
  | "deleting"
  | "accepted"
  | "failed"
  | "uncertain"
export type MessageRow = {
  seq: number
  id: string
  mailbox: string
  direction: "incoming" | "outgoing"
  status: MessageStatus
  created: number
  subject: string | null
  sender: string | null
  recipient: string | null
  object_key: string
  read: number
  digest: string | null
  idem: string | null
  request_hash: string | null
  provider_id: string | null
  error: string | null
}
type MessageSummary = Pick<
  MessageRow,
  | "seq"
  | "id"
  | "direction"
  | "status"
  | "created"
  | "subject"
  | "sender"
  | "recipient"
  | "read"
  | "provider_id"
  | "error"
>
type SendAttempt = Pick<
  MessageRow,
  "id" | "status" | "provider_id" | "error" | "request_hash"
>
type SendRequest = z.infer<typeof sendSchema>
const app = new Hono<AppEnvironment>()
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024
const id = () => crypto.randomUUID()
const hash = async (value: string | ArrayBuffer) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("")
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("")
const statement = (
  env: Env,
  sql: string,
  ...values: (string | number | null | ArrayBuffer)[]
) => env.DB.prepare(sql).bind(...values)
function hasErrorMessage(error: unknown, text: string): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(text) || hasErrorMessage(error.cause, text))
  )
}
class Failure extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
  ) {
    super(code)
  }
}
function fail(status: ContentfulStatusCode, code: string): never {
  throw new Failure(status, code)
}
app.onError((error, c) => {
  return c.json(
    {
      error: { code: error instanceof Failure ? error.code : "internal_error" },
    },
    error instanceof Failure ? error.status : 500,
  )
})
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
})
app.get("/health", (c) => c.json({ ok: true }))
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1]
  if (!auth) return fail(401, "unauthorized")
  const digest = await hash(auth)
  if (c.env.OWNER_TOKEN && digest === (await hash(c.env.OWNER_TOKEN)))
    c.set("principal", { kind: "owner", id: "owner" })
  else {
    const agent = await statement(
      c.env,
      "SELECT id FROM agents WHERE hash=? AND disabled=0",
      digest,
    ).first<{ id: string }>()
    if (agent) c.set("principal", { kind: "agent", id: agent.id })
    else {
      const mailboxKey = await statement(
        c.env,
        "SELECT k.mailbox AS id FROM keys k JOIN mailboxes m ON m.id=k.mailbox JOIN agents a ON a.id=m.agent WHERE k.hash=? AND k.revoked=0 AND m.disabled=0 AND a.disabled=0",
        digest,
      ).first<{ id: string }>()
      if (!mailboxKey) return fail(401, "unauthorized")
      c.set("principal", { kind: "mailbox", id: mailboxKey.id })
    }
  }
  await next()
})
function requireOwner(principal: Principal) {
  if (principal.kind !== "owner") fail(403, "forbidden")
}
async function findManagedMailbox(
  env: Env,
  principal: Principal,
  mailboxId: string,
) {
  const row = await statement(
    env,
    "SELECT * FROM mailboxes WHERE id=?",
    mailboxId,
  ).first<MailboxRow>()
  if (
    !row ||
    principal.kind === "mailbox" ||
    (principal.kind === "agent" && row.agent !== principal.id)
  )
    fail(404, "not_found")
  return row
}
function requireMailboxId(principal: Principal) {
  if (principal.kind !== "mailbox") fail(403, "mailbox_key_required")
  return principal.id
}
async function readJsonBody(c: AppContext): Promise<unknown> {
  const reader = c.req.raw.body?.getReader()
  if (!reader) return fail(400, "invalid_json")
  let size = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.length
    if (size > 8 * 1024 * 1024) {
      await reader.cancel()
      fail(413, "too_large")
    }
    chunks.push(chunk.value)
  }
  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer))
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    return fail(400, "invalid_json")
  }
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const validation = schema.safeParse(value)
  if (!validation.success) return fail(400, "invalid_request")
  return validation.data
}
app.post("/v1/admin/agents", async (c) => {
  requireOwner(c.get("principal"))
  const requestBody = parse(
    z.object({
      name: z.string().min(1).max(100),
      mailboxLimit: z.number().int().min(1).max(1000).optional(),
      dailyLimit: z.number().int().min(1).max(100000).optional(),
    }),
    await readJsonBody(c),
  )
  const credential = token(),
    agentId = id()
  await statement(
    c.env,
    "INSERT INTO agents(id,name,hash,mailbox_limit,daily_limit) VALUES(?,?,?,?,?)",
    agentId,
    requestBody.name,
    await hash(credential),
    requestBody.mailboxLimit ?? Number(c.env.MAILBOX_LIMIT || 10),
    requestBody.dailyLimit ?? Number(c.env.DAILY_LIMIT || 100),
  ).run()
  return c.json({ id: agentId, token: credential }, 201)
})
app.get("/v1/admin/agents", async (c) => {
  requireOwner(c.get("principal"))
  return c.json(
    (
      await statement(
        c.env,
        "SELECT id,name,disabled,mailbox_limit,daily_limit FROM agents",
      ).all<AgentRow>()
    ).results,
  )
})
app.delete("/v1/admin/agents/:id", async (c) => {
  requireOwner(c.get("principal"))
  await statement(
    c.env,
    "UPDATE agents SET disabled=1 WHERE id=?",
    c.req.param("id"),
  ).run()
  return c.body(null, 204)
})
app.get("/v1/mailboxes", async (c) => {
  const principal = c.get("principal")
  if (principal.kind === "mailbox") fail(403, "forbidden")
  return c.json(
    (
      await statement(
        c.env,
        principal.kind === "owner"
          ? "SELECT * FROM mailboxes"
          : "SELECT * FROM mailboxes WHERE agent=?",
        ...(principal.kind === "owner" ? [] : [principal.id]),
      ).all<MailboxRow>()
    ).results,
  )
})
app.post("/v1/mailboxes", async (c) => {
  const principal = c.get("principal")
  if (principal.kind !== "agent") fail(403, "provisioning_key_required")
  const requestBody = parse(
    z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }),
    await readJsonBody(c),
  )
  const mailboxId = id(),
    keyId = id(),
    credential = token()
  const reservation = await statement(
    c.env,
    "INSERT INTO mailboxes(id,agent,address) SELECT ?,id,? FROM agents WHERE id=? AND disabled=0 AND (SELECT count(*) FROM mailboxes WHERE agent=agents.id AND disabled=0)<mailbox_limit",
    mailboxId,
    `${requestBody.name}@${c.env.MAIL_DOMAIN}`,
    principal.id,
  )
    .run()
    .catch((error: unknown) => {
      if (hasErrorMessage(error, "UNIQUE constraint failed: mailboxes.address"))
        return fail(409, "address_unavailable")
      throw error
    })
  if (!reservation.meta.changes) fail(429, "mailbox_limit")
  await statement(
    c.env,
    "INSERT INTO keys(id,mailbox,hash) VALUES(?,?,?)",
    keyId,
    mailboxId,
    await hash(credential),
  ).run()
  return c.json(
    {
      id: mailboxId,
      address: `${requestBody.name}@${c.env.MAIL_DOMAIN}`,
      keyId,
      token: credential,
    },
    201,
  )
})
app.post("/v1/mailboxes/:id/keys", async (c) => {
  await findManagedMailbox(c.env, c.get("principal"), c.req.param("id"))
  const keyId = id(),
    credential = token()
  await statement(
    c.env,
    "INSERT INTO keys(id,mailbox,hash) VALUES(?,?,?)",
    keyId,
    c.req.param("id"),
    await hash(credential),
  ).run()
  return c.json({ id: keyId, token: credential }, 201)
})
app.delete("/v1/mailboxes/:id/keys/:key", async (c) => {
  await findManagedMailbox(c.env, c.get("principal"), c.req.param("id"))
  await statement(
    c.env,
    "UPDATE keys SET revoked=1 WHERE id=? AND mailbox=?",
    c.req.param("key"),
    c.req.param("id"),
  ).run()
  return c.body(null, 204)
})
app.delete("/v1/mailboxes/:id", async (c) => {
  await findManagedMailbox(c.env, c.get("principal"), c.req.param("id"))
  await statement(
    c.env,
    "UPDATE mailboxes SET disabled=1 WHERE id=?",
    c.req.param("id"),
  ).run()
  return c.body(null, 204)
})
app.get("/v1/messages", async (c) => {
  const mailboxId = requireMailboxId(c.get("principal"))
  const after = Number(c.req.query("after") || 0),
    limit = Number(c.req.query("limit") || 50),
    direction = c.req.query("direction"),
    unread = c.req.query("unread")
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (direction && !["incoming", "outgoing"].includes(direction)) ||
    (unread && !["true", "false"].includes(unread))
  )
    fail(400, "invalid_query")
  const rows = await statement(
    c.env,
    `SELECT seq,id,direction,status,created,subject,sender,recipient,read,provider_id,error FROM messages WHERE mailbox=? AND seq>? AND status NOT IN ('pending','deleting')${direction ? " AND direction=?" : ""}${unread ? " AND read=?" : ""} ORDER BY seq LIMIT ?`,
    mailboxId,
    after,
    ...(direction ? [direction] : []),
    ...(unread ? [unread === "true" ? 0 : 1] : []),
    limit,
  ).all<MessageSummary>()
  return c.json({
    messages: rows.results,
    nextCursor: rows.results.at(-1)?.seq ?? after,
  })
})
async function findMessage(env: Env, mailboxId: string, messageId: string) {
  const row = await statement(
    env,
    "SELECT * FROM messages WHERE id=? AND mailbox=? AND status NOT IN ('pending','deleting')",
    messageId,
    mailboxId,
  ).first<MessageRow>()
  if (!row) return fail(404, "not_found")
  return row
}
async function incomingContent(env: Env, record: MessageRow): Promise<Email> {
  const object = await env.MAIL.get(record.object_key)
  if (!object) return fail(503, "content_unavailable")
  const cached = await env.MAIL.get(`${record.object_key}/parsed`)
  // Cache entries are written only from PostalMime output by this Worker.
  if (cached) return cached.json<Email>()
  const raw = await object.arrayBuffer()
  const parsed = await PostalMime.parse(raw, {
    attachmentEncoding: "base64",
  }).catch((_error: unknown) => fail(422, "parse_failed_use_raw"))
  await env.MAIL.put(`${record.object_key}/parsed`, JSON.stringify(parsed))
  return parsed
}
async function content(
  env: Env,
  record: MessageRow,
): Promise<Email | SendRequest> {
  if (record.direction === "incoming") return incomingContent(env, record)
  const object = await env.MAIL.get(record.object_key)
  if (!object) return fail(503, "content_unavailable")
  return sendSchema.parse(await object.json<unknown>())
}
app.get("/v1/messages/:id", async (c) => {
  const message = await findMessage(
    c.env,
    requireMailboxId(c.get("principal")),
    c.req.param("id"),
  )
  const parsedContent = await content(c.env, message)
  return c.json({
    ...message,
    object_key: undefined,
    digest: undefined,
    request_hash: undefined,
    content: {
      ...parsedContent,
      attachments: parsedContent.attachments?.map(
        (attachment, attachmentIndex) => ({
          ...attachment,
          content: undefined,
          id: attachmentIndex,
        }),
      ),
    },
  })
})
app.get("/v1/messages/:id/raw", async (c) => {
  const message = await findMessage(
    c.env,
    requireMailboxId(c.get("principal")),
    c.req.param("id"),
  )
  if (message.direction !== "incoming") fail(404, "not_found")
  const object = await c.env.MAIL.get(message.object_key)
  if (!object) return fail(503, "content_unavailable")
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="message.eml"',
      "Cache-Control": "no-store",
    },
  })
})
function attachmentContent(value: string | ArrayBuffer | Uint8Array): string {
  if (typeof value !== "string") return fail(500, "internal_error")
  return value
}
app.get("/v1/messages/:id/attachments/:index", async (c) => {
  const message = await findMessage(
    c.env,
    requireMailboxId(c.get("principal")),
    c.req.param("id"),
  )
  const parsedContent = await content(c.env, message),
    index = Number(c.req.param("index"))
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !parsedContent.attachments?.[index]
  )
    fail(404, "not_found")
  const attachment = parsedContent.attachments[index]
  return new Response(
    Uint8Array.from(atob(attachmentContent(attachment.content)), (x) =>
      x.charCodeAt(0),
    ),
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="attachment"',
        "Cache-Control": "no-store",
      },
    },
  )
})
app.patch("/v1/messages/:id", async (c) => {
  const mailboxId = requireMailboxId(c.get("principal"))
  await findMessage(c.env, mailboxId, c.req.param("id"))
  const requestBody = parse(
    z.object({ read: z.boolean() }),
    await readJsonBody(c),
  )
  await statement(
    c.env,
    "UPDATE messages SET read=? WHERE id=? AND mailbox=?",
    requestBody.read ? 1 : 0,
    c.req.param("id"),
    mailboxId,
  ).run()
  return c.body(null, 204)
})
app.delete("/v1/messages/:id", async (c) => {
  const message = await findMessage(
    c.env,
    requireMailboxId(c.get("principal")),
    c.req.param("id"),
  )
  await statement(
    c.env,
    "UPDATE messages SET status='deleting' WHERE id=?",
    message.id,
  ).run()
  await remove(c.env, message)
  return c.body(null, 204)
})
const address = z
  .string()
  .email()
  .max(320)
  .refine((s) => !/[\r\n]/.test(s))
const sendSchema = z
  .object({
    to: z.array(address).min(1),
    cc: z.array(address).optional(),
    bcc: z.array(address).optional(),
    subject: z
      .string()
      .max(998)
      .refine((s) => !/[\r\n]/.test(s)),
    text: z.string().optional(),
    html: z.string().optional(),
    name: z
      .string()
      .max(100)
      .refine((s) => !/[\r\n]/.test(s))
      .optional(),
    attachments: z
      .array(
        z.object({
          filename: z
            .string()
            .min(1)
            .max(255)
            .refine((s) => !/[\r\n]/.test(s)),
          type: z
            .string()
            .max(100)
            .refine((s) => !/[\r\n]/.test(s)),
          content: z
            .string()
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        }),
      )
      .max(32)
      .optional(),
  })
  .refine((b) => !!(b.text || b.html))
async function send(c: AppContext, reply?: MessageRow): Promise<Response> {
  const env = c.env,
    mailboxId = requireMailboxId(c.get("principal"))
  const email = env.EMAIL
  if (!email) return fail(409, "sending_disabled")
  let input = await readJsonBody(c)
  let headers: Record<string, string> | undefined
  if (reply) {
    const originalEmail = await incomingContent(env, reply)
    const replyInput = parse(z.record(z.string(), z.unknown()), input)
    const target =
      originalEmail.replyTo?.[0]?.address || originalEmail.from?.address
    if (!target) fail(400, "no_reply_address")
    input = {
      ...replyInput,
      to: [target],
      subject:
        replyInput.subject ??
        (/^re:/i.test(originalEmail.subject || "")
          ? originalEmail.subject
          : `Re: ${originalEmail.subject || ""}`),
    }
    if (originalEmail.messageId) {
      headers = {
        "In-Reply-To": originalEmail.messageId,
        References: (
          [originalEmail.references, originalEmail.messageId]
            .flat()
            .filter(Boolean)
            .join(" ")
            .match(/<[^<>\r\n]+>/g) || []
        )
          .slice(-20)
          .reduce(
            (result, entry) =>
              (result + " " + entry).trim().length <= 1800
                ? (result + " " + entry).trim()
                : entry,
            "",
          ),
      }
      if (Object.values(headers).some((s) => /[\r\n]/.test(s)))
        fail(400, "invalid_reply_headers")
    }
  }
  const sendInput = parse(sendSchema, input)
  const recipientCount =
    sendInput.to.length +
    (sendInput.cc?.length || 0) +
    (sendInput.bcc?.length || 0)
  if (recipientCount > 50) fail(400, "too_many_recipients")
  if (
    new TextEncoder().encode(JSON.stringify(sendInput)).length + 16384 >
    MAX_MESSAGE_BYTES
  )
    fail(413, "too_large")
  const idempotencyKey = c.req.header("Idempotency-Key")
  if (!idempotencyKey || idempotencyKey.length > 200)
    fail(400, "idempotency_key_required")
  // Keep the persisted hash format compatible with existing idempotency records.
  const digest = await hash(JSON.stringify({ b: sendInput, headers }))
  const previous = async () => {
    const attempt = await statement(
      env,
      "SELECT id,status,provider_id,error,request_hash FROM messages WHERE mailbox=? AND idem=?",
      mailboxId,
      idempotencyKey,
    ).first<SendAttempt>()
    if (attempt && attempt.request_hash !== digest)
      fail(409, "idempotency_conflict")
    return attempt
  }
  const existingAttempt = await previous()
  if (existingAttempt)
    return c.json({ ...existingAttempt, request_hash: undefined })
  const messageId = id(),
    objectKey = `messages/${messageId}`,
    now = Date.now()
  const competingAttempt = await statement(
    env,
    "INSERT INTO messages(id,mailbox,direction,status,created,subject,sender,recipient,object_key,idem,request_hash) VALUES(?,?,'outgoing','pending',?,?,?,?,?,?,?)",
    messageId,
    mailboxId,
    now,
    sendInput.subject,
    "",
    JSON.stringify(sendInput.to),
    objectKey,
    idempotencyKey,
    digest,
  )
    .run()
    .then(() => null)
    .catch(async (error: unknown) => {
      const existing = await previous()
      if (existing) return existing
      throw error
    })
  if (competingAttempt)
    return c.json({ ...competingAttempt, request_hash: undefined })
  await env.MAIL.put(objectKey, JSON.stringify(sendInput))
  const row = await statement(
    env,
    "SELECT m.address,a.daily_limit FROM mailboxes m JOIN agents a ON a.id=m.agent WHERE m.id=?",
    mailboxId,
  ).first<{ address: string; daily_limit: number }>()
  if (!row) return fail(404, "not_found")
  const day = new Date().toISOString().slice(0, 10)
  const quota = await statement(
    env,
    "INSERT INTO usage(mailbox,day,count) SELECT ?,?,? WHERE ?<=? ON CONFLICT(mailbox,day) DO UPDATE SET count=count+excluded.count WHERE count+excluded.count<=?",
    mailboxId,
    day,
    recipientCount,
    recipientCount,
    row.daily_limit,
    row.daily_limit,
  ).run()
  if (!quota.meta.changes) {
    await statement(
      env,
      "UPDATE messages SET status='failed',error='daily_limit' WHERE id=?",
      messageId,
    ).run()
    fail(429, "daily_limit")
  }
  await statement(
    env,
    "UPDATE messages SET status='uncertain',sender=? WHERE id=?",
    row.address,
    messageId,
  ).run()
  // Persist uncertainty before calling the provider; a lost response must not resend.
  const outcome = await email
    .send({
      ...sendInput,
      from: sendInput.name
        ? { email: row.address, name: sendInput.name }
        : row.address,
      attachments: sendInput.attachments?.map((attachment) => ({
        ...attachment,
        disposition: "attachment" as const,
      })),
      headers,
    })
    .then((result) => ({ kind: "accepted" as const, result }))
    .catch(async (error: unknown) => {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined
      const known =
        code !== undefined &&
        [
          "E_VALIDATION_ERROR",
          "E_SENDER_NOT_VERIFIED",
          "E_RECIPIENT_SUPPRESSED",
          "E_RATE_LIMIT_EXCEEDED",
          "E_DAILY_LIMIT_EXCEEDED",
          "E_CONTENT_TOO_LARGE",
          "E_RECIPIENT_NOT_ALLOWED",
          "E_ACCOUNT_SUSPENDED",
          "E_SENDER_DOMAIN_NOT_AVAILABLE",
          "E_TOO_MANY_RECIPIENTS",
          "E_TOO_MANY_ATTACHMENTS",
        ].includes(code)
      const status = known ? "failed" : "uncertain"
      await statement(
        env,
        "UPDATE messages SET status=?,error=? WHERE id=?",
        status,
        known ? code : "provider_outcome_unknown",
        messageId,
      ).run()
      return { kind: "rejected" as const, status }
    })
  if (outcome.kind === "rejected")
    return c.json({ id: messageId, status: outcome.status }, 502)
  await statement(
    env,
    "UPDATE messages SET status='accepted',provider_id=? WHERE id=?",
    outcome.result.messageId,
    messageId,
  ).run()
  return c.json(
    {
      id: messageId,
      status: "accepted",
      provider_id: outcome.result.messageId,
    },
    201,
  )
}
app.post("/v1/send", (c) => send(c))
app.post("/v1/messages/:id/reply", async (c) => {
  const message = await findMessage(
    c.env,
    requireMailboxId(c.get("principal")),
    c.req.param("id"),
  )
  if (message.direction !== "incoming") fail(400, "incoming_required")
  return send(c, message)
})
async function remove(env: Env, record: MessageRow) {
  await env.MAIL.delete([record.object_key, `${record.object_key}/parsed`])
  await statement(
    env,
    "DELETE FROM messages WHERE id=? AND status='deleting'",
    record.id,
  ).run()
}
export async function cleanup(env: Env): Promise<void> {
  const now = Date.now(),
    days = Number(env.RETENTION_DAYS || 0)
  if (days > 0)
    await statement(
      env,
      "UPDATE messages SET status='deleting' WHERE id IN (SELECT id FROM messages WHERE created<? LIMIT 100)",
      now - days * 86400000,
    ).run()
  const rows = await statement(
    env,
    "SELECT * FROM messages WHERE status='deleting' OR (status='pending' AND created<?) LIMIT 100",
    now - 3600000,
  ).all<MessageRow>()
  for (const record of rows.results) {
    if (record.status === "deleting") {
      await remove(env, record)
      continue
    }
    const object = await env.MAIL.head(record.object_key)
    if (record.direction === "incoming" && object)
      await statement(
        env,
        "UPDATE messages SET status='ready' WHERE id=?",
        record.id,
      ).run()
    else if (record.direction === "outgoing")
      await statement(
        env,
        "UPDATE messages SET status='failed',error='interrupted_before_send' WHERE id=?",
        record.id,
      ).run()
    else
      await statement(env, "DELETE FROM messages WHERE id=?", record.id).run()
  }
  await statement(
    env,
    "DELETE FROM usage WHERE day<?",
    new Date(now - 7 * 86400000).toISOString().slice(0, 10),
  ).run()
}
export default {
  fetch: app.fetch,
  async email(incomingMessage: ForwardableEmailMessage, env: Env) {
    if (incomingMessage.rawSize > MAX_MESSAGE_BYTES) {
      incomingMessage.setReject("Message exceeds 5 MiB")
      return
    }
    const mailbox = await statement(
      env,
      "SELECT m.id FROM mailboxes m JOIN agents a ON a.id=m.agent WHERE m.address=? AND m.disabled=0 AND a.disabled=0",
      incomingMessage.to.toLowerCase(),
    ).first<{ id: string }>()
    if (!mailbox) {
      incomingMessage.setReject("Unknown recipient")
      return
    }
    const raw = await new Response(incomingMessage.raw).arrayBuffer()
    if (raw.byteLength > MAX_MESSAGE_BYTES) {
      incomingMessage.setReject("Message exceeds 5 MiB")
      return
    }
    const digest = await hash(raw),
      messageId = id(),
      objectKey = `messages/${messageId}`
    const reservation = await statement(
      env,
      "INSERT OR IGNORE INTO messages(id,mailbox,direction,status,created,subject,sender,recipient,object_key,digest) VALUES(?,?,'incoming','pending',?,?,?,?,?,?)",
      messageId,
      mailbox.id,
      Date.now(),
      incomingMessage.headers.get("subject") || "",
      incomingMessage.from,
      incomingMessage.to,
      objectKey,
      digest,
    ).run()
    if (!reservation.meta.changes) {
      const prior = await statement(
        env,
        "SELECT status FROM messages WHERE mailbox=? AND digest=?",
        mailbox.id,
        digest,
      ).first<Pick<MessageRow, "status">>()
      if (prior?.status === "pending") throw new Error("ingest_pending")
      return
    }
    await env.MAIL.put(objectKey, raw)
    await statement(
      env,
      "UPDATE messages SET status='ready' WHERE id=?",
      messageId,
    ).run()
  },
  scheduled: (_: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(cleanup(env)),
} satisfies ExportedHandler<Env>
