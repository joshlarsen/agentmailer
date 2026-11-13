import { Hono } from "hono";
import PostalMime from "postal-mime";
import { z } from "zod";
interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL?: SendEmail;
  OWNER_TOKEN: string;
  MAIL_DOMAIN: string;
  RETENTION_DAYS: string;
  MAILBOX_LIMIT: string;
  DAILY_LIMIT: string;
}
type Principal = { kind: "owner" | "agent" | "mailbox"; id: string };
const app = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();
const MAX = 5 * 1024 * 1024;
const id = () => crypto.randomUUID();
const hash = async (s: string | ArrayBuffer) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof s === "string" ? new TextEncoder().encode(s) : s,
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
const stmt = (e: Env, s: string, ...v: any[]) => e.DB.prepare(s).bind(...v);
class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string): never => {
  throw new Failure(status, code);
};
app.onError((e, c) => {
  return c.json(
    { error: { code: e instanceof Failure ? e.code : "internal_error" } },
    (e instanceof Failure ? e.status : 500) as any,
  );
});
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/health", (c) => c.json({ ok: true }));
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!auth) return fail(401, "unauthorized");
  const digest = await hash(auth);
  if (c.env.OWNER_TOKEN && digest === (await hash(c.env.OWNER_TOKEN)))
    c.set("principal", { kind: "owner", id: "owner" });
  else {
    const a = await stmt(
      c.env,
      "SELECT id FROM agents WHERE hash=? AND disabled=0",
      digest,
    ).first<{ id: string }>();
    if (a) c.set("principal", { kind: "agent", id: a.id });
    else {
      const k = await stmt(
        c.env,
        "SELECT k.mailbox AS id FROM keys k JOIN mailboxes m ON m.id=k.mailbox JOIN agents a ON a.id=m.agent WHERE k.hash=? AND k.revoked=0 AND m.disabled=0 AND a.disabled=0",
        digest,
      ).first<{ id: string }>();
      if (!k) return fail(401, "unauthorized");
      c.set("principal", { kind: "mailbox", id: k.id });
    }
  }
  await next();
});
function owner(p: Principal) {
  if (p.kind !== "owner") fail(403, "forbidden");
}
async function managed(e: Env, p: Principal, m: string) {
  const row = await stmt(
    e,
    "SELECT * FROM mailboxes WHERE id=?",
    m,
  ).first<any>();
  if (
    !row ||
    p.kind === "mailbox" ||
    (p.kind === "agent" && row.agent !== p.id)
  )
    fail(404, "not_found");
  return row;
}
function mailbox(p: Principal) {
  if (p.kind !== "mailbox") fail(403, "mailbox_key_required");
  return p.id;
}
async function body(c: any) {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "invalid_json");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader!.read();
    if (r.done) break;
    size += r.value.length;
    if (size > 8 * 1024 * 1024) {
      await reader!.cancel();
      fail(413, "too_large");
    }
    chunks.push(r.value);
  }
  const b = new Uint8Array(size);
  let n = 0;
  for (const ch of chunks) {
    b.set(ch, n);
    n += ch.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    return fail(400, "invalid_json");
  }
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) return fail(400, "invalid_request");
  return r.data;
};
app.post("/v1/admin/agents", async (c) => {
  owner(c.get("principal"));
  const b = parse(
    z.object({
      name: z.string().min(1).max(100),
      mailboxLimit: z.number().int().min(1).max(1000).optional(),
      dailyLimit: z.number().int().min(1).max(100000).optional(),
    }),
    await body(c),
  );
  const t = token(),
    a = id();
  await stmt(
    c.env,
    "INSERT INTO agents(id,name,hash,mailbox_limit,daily_limit) VALUES(?,?,?,?,?)",
    a,
    b.name,
    await hash(t),
    b.mailboxLimit ?? Number(c.env.MAILBOX_LIMIT || 10),
    b.dailyLimit ?? Number(c.env.DAILY_LIMIT || 100),
  ).run();
  return c.json({ id: a, token: t }, 201);
});
app.get("/v1/admin/agents", async (c) => {
  owner(c.get("principal"));
  return c.json(
    (
      await stmt(
        c.env,
        "SELECT id,name,disabled,mailbox_limit,daily_limit FROM agents",
      ).all()
    ).results,
  );
});
app.delete("/v1/admin/agents/:id", async (c) => {
  owner(c.get("principal"));
  await stmt(
    c.env,
    "UPDATE agents SET disabled=1 WHERE id=?",
    c.req.param("id"),
  ).run();
  return c.body(null, 204);
});
app.get("/v1/mailboxes", async (c) => {
  const p = c.get("principal");
  if (p.kind === "mailbox") fail(403, "forbidden");
  return c.json(
    (
      await stmt(
        c.env,
        p.kind === "owner"
          ? "SELECT * FROM mailboxes"
          : "SELECT * FROM mailboxes WHERE agent=?",
        ...(p.kind === "owner" ? [] : [p.id]),
      ).all()
    ).results,
  );
});
app.post("/v1/mailboxes", async (c) => {
  const p = c.get("principal");
  if (p.kind !== "agent") fail(403, "provisioning_key_required");
  const b = parse(
    z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }),
    await body(c),
  );
  const m = id(),
    k = id(),
    t = token();
  try {
    const r = await stmt(
      c.env,
      "INSERT INTO mailboxes(id,agent,address) SELECT ?,id,? FROM agents WHERE id=? AND disabled=0 AND (SELECT count(*) FROM mailboxes WHERE agent=agents.id AND disabled=0)<mailbox_limit",
      m,
      `${b.name}@${c.env.MAIL_DOMAIN}`,
      p.id,
    ).run();
    if (!r.meta.changes) fail(429, "mailbox_limit");
  } catch (e) {
    if (e instanceof Failure) throw e;
    fail(409, "address_unavailable");
  }
  await stmt(
    c.env,
    "INSERT INTO keys(id,mailbox,hash) VALUES(?,?,?)",
    k,
    m,
    await hash(t),
  ).run();
  return c.json(
    { id: m, address: `${b.name}@${c.env.MAIL_DOMAIN}`, keyId: k, token: t },
    201,
  );
});
app.post("/v1/mailboxes/:id/keys", async (c) => {
  await managed(c.env, c.get("principal"), c.req.param("id"));
  const k = id(),
    t = token();
  await stmt(
    c.env,
    "INSERT INTO keys(id,mailbox,hash) VALUES(?,?,?)",
    k,
    c.req.param("id"),
    await hash(t),
  ).run();
  return c.json({ id: k, token: t }, 201);
});
app.delete("/v1/mailboxes/:id/keys/:key", async (c) => {
  await managed(c.env, c.get("principal"), c.req.param("id"));
  await stmt(
    c.env,
    "UPDATE keys SET revoked=1 WHERE id=? AND mailbox=?",
    c.req.param("key"),
    c.req.param("id"),
  ).run();
  return c.body(null, 204);
});
app.delete("/v1/mailboxes/:id", async (c) => {
  await managed(c.env, c.get("principal"), c.req.param("id"));
  await stmt(
    c.env,
    "UPDATE mailboxes SET disabled=1 WHERE id=?",
    c.req.param("id"),
  ).run();
  return c.body(null, 204);
});
app.get("/v1/messages", async (c) => {
  const m = mailbox(c.get("principal"));
  const after = Number(c.req.query("after") || 0),
    limit = Number(c.req.query("limit") || 50),
    direction = c.req.query("direction"),
    unread = c.req.query("unread");
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (direction && !["incoming", "outgoing"].includes(direction)) ||
    (unread && !["true", "false"].includes(unread))
  )
    fail(400, "invalid_query");
  const rows = await stmt(
    c.env,
    `SELECT seq,id,direction,status,created,subject,sender,recipient,read,provider_id,error FROM messages WHERE mailbox=? AND seq>? AND status NOT IN ('pending','deleting')${direction ? " AND direction=?" : ""}${unread ? " AND read=?" : ""} ORDER BY seq LIMIT ?`,
    m,
    after,
    ...(direction ? [direction] : []),
    ...(unread ? [unread === "true" ? 0 : 1] : []),
    limit,
  ).all<any>();
  return c.json({
    messages: rows.results,
    nextCursor: rows.results.at(-1)?.seq ?? after,
  });
});
async function message(e: Env, m: string, i: string) {
  const row = await stmt(
    e,
    "SELECT * FROM messages WHERE id=? AND mailbox=? AND status NOT IN ('pending','deleting')",
    i,
    m,
  ).first<any>();
  if (!row) fail(404, "not_found");
  return row;
}
async function content(e: Env, r: any) {
  const obj = await e.MAIL.get(r.object_key);
  if (!obj) fail(503, "content_unavailable");
  if (r.direction === "outgoing") return obj!.json<any>();
  const cache = await e.MAIL.get(`${r.object_key}/parsed`);
  if (cache) return cache.json<any>();
  try {
    const p = await PostalMime.parse(await obj!.arrayBuffer(), {
      attachmentEncoding: "base64",
    });
    await e.MAIL.put(`${r.object_key}/parsed`, JSON.stringify(p));
    return p;
  } catch {
    fail(422, "parse_failed_use_raw");
  }
}
app.get("/v1/messages/:id", async (c) => {
  const r = await message(
    c.env,
    mailbox(c.get("principal")),
    c.req.param("id"),
  );
  const p = await content(c.env, r);
  return c.json({
    ...r,
    object_key: undefined,
    digest: undefined,
    request_hash: undefined,
    content: {
      ...p,
      attachments: p.attachments?.map((a: any, i: number) => ({
        ...a,
        content: undefined,
        id: i,
      })),
    },
  });
});
app.get("/v1/messages/:id/raw", async (c) => {
  const r = await message(
    c.env,
    mailbox(c.get("principal")),
    c.req.param("id"),
  );
  if (r.direction !== "incoming") fail(404, "not_found");
  const o = await c.env.MAIL.get(r.object_key);
  if (!o) fail(503, "content_unavailable");
  return new Response(o!.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="message.eml"',
      "Cache-Control": "no-store",
    },
  });
});
app.get("/v1/messages/:id/attachments/:index", async (c) => {
  const r = await message(
    c.env,
    mailbox(c.get("principal")),
    c.req.param("id"),
  );
  const p = await content(c.env, r),
    index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0 || !p.attachments?.[index])
    fail(404, "not_found");
  const a = p.attachments[index];
  return new Response(
    Uint8Array.from(atob(a.content), (x) => x.charCodeAt(0)),
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="attachment"',
        "Cache-Control": "no-store",
      },
    },
  );
});
app.patch("/v1/messages/:id", async (c) => {
  const m = mailbox(c.get("principal"));
  await message(c.env, m, c.req.param("id"));
  const b = parse(z.object({ read: z.boolean() }), await body(c));
  await stmt(
    c.env,
    "UPDATE messages SET read=? WHERE id=? AND mailbox=?",
    b.read ? 1 : 0,
    c.req.param("id"),
    m,
  ).run();
  return c.body(null, 204);
});
app.delete("/v1/messages/:id", async (c) => {
  const r = await message(
    c.env,
    mailbox(c.get("principal")),
    c.req.param("id"),
  );
  await stmt(
    c.env,
    "UPDATE messages SET status='deleting' WHERE id=?",
    r.id,
  ).run();
  await remove(c.env, r);
  return c.body(null, 204);
});
const address = z
  .string()
  .email()
  .max(320)
  .refine((s) => !/[\r\n]/.test(s));
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
  .refine((b) => !!(b.text || b.html));
async function send(c: any, reply?: any) {
  const e: Env = c.env,
    m = mailbox(c.get("principal"));
  if (!e.EMAIL) fail(409, "sending_disabled");
  let input = await body(c);
  let headers: Record<string, string> | undefined;
  if (reply) {
    const p = await content(e, reply);
    const target = p.replyTo?.[0]?.address || p.from?.address;
    if (!target) fail(400, "no_reply_address");
    input = {
      ...input,
      to: [target],
      subject:
        input.subject ??
        (/^re:/i.test(p.subject || "") ? p.subject : `Re: ${p.subject || ""}`),
    };
    if (p.messageId) {
      headers = {
        "In-Reply-To": p.messageId,
        References: (
          [p.references, p.messageId]
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
      };
      if (Object.values(headers).some((s) => /[\r\n]/.test(s)))
        fail(400, "invalid_reply_headers");
    }
  }
  const b = parse(sendSchema, input);
  const count = b.to.length + (b.cc?.length || 0) + (b.bcc?.length || 0);
  if (count > 50) fail(400, "too_many_recipients");
  if (new TextEncoder().encode(JSON.stringify(b)).length + 16384 > MAX)
    fail(413, "too_large");
  const idem = c.req.header("Idempotency-Key");
  if (!idem || idem.length > 200) fail(400, "idempotency_key_required");
  const digest = await hash(JSON.stringify({ b, headers }));
  const previous = async () => {
    const r = await stmt(
      e,
      "SELECT id,status,provider_id,error,request_hash FROM messages WHERE mailbox=? AND idem=?",
      m,
      idem,
    ).first<any>();
    if (r && r.request_hash !== digest) fail(409, "idempotency_conflict");
    return r;
  };
  let old = await previous();
  if (old) return c.json({ ...old, request_hash: undefined });
  const i = id(),
    key = `messages/${i}`,
    now = Date.now();
  try {
    await stmt(
      e,
      "INSERT INTO messages(id,mailbox,direction,status,created,subject,sender,recipient,object_key,idem,request_hash) VALUES(?,?,'outgoing','pending',?,?,?,?,?,?,?)",
      i,
      m,
      now,
      b.subject,
      "",
      JSON.stringify(b.to),
      key,
      idem,
      digest,
    ).run();
  } catch (err) {
    old = await previous();
    if (old) return c.json({ ...old, request_hash: undefined });
    throw err;
  }
  await e.MAIL.put(key, JSON.stringify(b));
  const row = await stmt(
    e,
    "SELECT m.address,a.daily_limit FROM mailboxes m JOIN agents a ON a.id=m.agent WHERE m.id=?",
    m,
  ).first<any>();
  const day = new Date().toISOString().slice(0, 10);
  const quota = await stmt(
    e,
    "INSERT INTO usage(mailbox,day,count) SELECT ?,?,? WHERE ?<=? ON CONFLICT(mailbox,day) DO UPDATE SET count=count+excluded.count WHERE count+excluded.count<=?",
    m,
    day,
    count,
    count,
    row.daily_limit,
    row.daily_limit,
  ).run();
  if (!quota.meta.changes) {
    await stmt(
      e,
      "UPDATE messages SET status='failed',error='daily_limit' WHERE id=?",
      i,
    ).run();
    fail(429, "daily_limit");
  }
  await stmt(
    e,
    "UPDATE messages SET status='uncertain',sender=? WHERE id=?",
    row.address,
    i,
  ).run();
  let result;
  try {
    result = await e.EMAIL!.send({
      ...b,
      from: b.name ? { email: row.address, name: b.name } : row.address,
      attachments: b.attachments?.map((a) => ({
        ...a,
        disposition: "attachment" as const,
      })),
      headers,
    });
  } catch (err: any) {
    const known =
      typeof err.code === "string" &&
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
      ].includes(err.code);
    await stmt(
      e,
      "UPDATE messages SET status=?,error=? WHERE id=?",
      known ? "failed" : "uncertain",
      known ? err.code : "provider_outcome_unknown",
      i,
    ).run();
    return c.json({ id: i, status: known ? "failed" : "uncertain" }, 502);
  }
  await stmt(
    e,
    "UPDATE messages SET status='accepted',provider_id=? WHERE id=?",
    result.messageId,
    i,
  ).run();
  return c.json(
    { id: i, status: "accepted", provider_id: result.messageId },
    201,
  );
}
app.post("/v1/send", (c) => send(c));
app.post("/v1/messages/:id/reply", async (c) => {
  const r = await message(
    c.env,
    mailbox(c.get("principal")),
    c.req.param("id"),
  );
  if (r.direction !== "incoming") fail(400, "incoming_required");
  return send(c, r);
});
async function remove(e: Env, r: any) {
  await e.MAIL.delete([r.object_key, `${r.object_key}/parsed`]);
  await stmt(
    e,
    "DELETE FROM messages WHERE id=? AND status='deleting'",
    r.id,
  ).run();
}
export async function cleanup(e: Env) {
  const now = Date.now(),
    days = Number(e.RETENTION_DAYS || 0);
  if (days > 0)
    await stmt(
      e,
      "UPDATE messages SET status='deleting' WHERE id IN (SELECT id FROM messages WHERE created<? LIMIT 100)",
      now - days * 86400000,
    ).run();
  const rows = await stmt(
    e,
    "SELECT * FROM messages WHERE status='deleting' OR (status='pending' AND created<?) LIMIT 100",
    now - 3600000,
  ).all<any>();
  for (const r of rows.results) {
    if (r.status === "deleting") {
      await remove(e, r);
      continue;
    }
    const o = await e.MAIL.head(r.object_key);
    if (r.direction === "incoming" && o)
      await stmt(
        e,
        "UPDATE messages SET status='ready' WHERE id=?",
        r.id,
      ).run();
    else if (r.direction === "outgoing")
      await stmt(
        e,
        "UPDATE messages SET status='failed',error='interrupted_before_send' WHERE id=?",
        r.id,
      ).run();
    else await stmt(e, "DELETE FROM messages WHERE id=?", r.id).run();
  }
  await stmt(
    e,
    "DELETE FROM usage WHERE day<?",
    new Date(now - 7 * 86400000).toISOString().slice(0, 10),
  ).run();
}
export default {
  fetch: app.fetch,
  async email(msg: ForwardableEmailMessage, e: Env) {
    if (msg.rawSize > MAX) {
      msg.setReject("Message exceeds 5 MiB");
      return;
    }
    const m = await stmt(
      e,
      "SELECT m.id FROM mailboxes m JOIN agents a ON a.id=m.agent WHERE m.address=? AND m.disabled=0 AND a.disabled=0",
      msg.to.toLowerCase(),
    ).first<{ id: string }>();
    if (!m) {
      msg.setReject("Unknown recipient");
      return;
    }
    const raw = await new Response(msg.raw).arrayBuffer();
    if (raw.byteLength > MAX) {
      msg.setReject("Message exceeds 5 MiB");
      return;
    }
    const digest = await hash(raw),
      i = id(),
      key = `messages/${i}`;
    const r = await stmt(
      e,
      "INSERT OR IGNORE INTO messages(id,mailbox,direction,status,created,subject,sender,recipient,object_key,digest) VALUES(?,?,'incoming','pending',?,?,?,?,?,?)",
      i,
      m.id,
      Date.now(),
      msg.headers.get("subject") || "",
      msg.from,
      msg.to,
      key,
      digest,
    ).run();
    if (!r.meta.changes) {
      const prior = await stmt(
        e,
        "SELECT status FROM messages WHERE mailbox=? AND digest=?",
        m.id,
        digest,
      ).first<any>();
      if (prior?.status === "pending") throw new Error("ingest_pending");
      return;
    }
    await e.MAIL.put(key, raw);
    await stmt(e, "UPDATE messages SET status='ready' WHERE id=?", i).run();
  },
  scheduled: (_: ScheduledController, e: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(cleanup(e)),
} satisfies ExportedHandler<Env>;
