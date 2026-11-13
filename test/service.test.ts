import { env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import worker, { cleanup } from "../src/index";
import migration from "../migrations/0001.sql?raw";
const e = env as any;
const call = (
  path: string,
  t: string,
  data?: any,
  method = data ? "POST" : "GET",
  extra = {},
) =>
  worker.fetch(
    new Request("https://mail.test" + path, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    e,
    {} as any,
  );
const json = async (r: Response) => {
  const b = (await r.json()) as any;
  if (r.status >= 400) throw new Error(JSON.stringify(b));
  return b;
};
let agent: any, box: any;
beforeAll(async () => {
  await e.DB.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  agent = await json(
    await call("/v1/admin/agents", "test-owner", {
      name: "test",
      mailboxLimit: 2,
      dailyLimit: 2,
    }),
  );
  box = await json(await call("/v1/mailboxes", agent.token, { name: "alpha" }));
});
it("isolates roles and atomically limits mailbox creation", async () => {
  expect((await call("/v1/messages", agent.token)).status).toBe(403);
  const results = await Promise.all(
    ["beta", "gamma"].map((name) =>
      call("/v1/mailboxes", agent.token, { name }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
  expect((await call("/v1/admin/agents", box.token)).status).toBe(403);
});
it("stores, deduplicates, parses, polls and deletes MIME", async () => {
  const raw =
    "From: Human <human@example.net>\r\nTo: alpha@agents.example.com\r\nSubject: Hello\r\nMessage-ID: <a@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world";
  const incoming = () =>
    ({
      from: "human@example.net",
      to: box.address,
      rawSize: raw.length,
      raw: new Response(raw).body,
      headers: new Headers({ subject: "Hello" }),
      setReject: vi.fn(),
    }) as any;
  await worker.email(incoming(), e);
  await worker.email(incoming(), e);
  const inbox = await json(await call("/v1/messages", box.token));
  expect(inbox.messages).toHaveLength(1);
  const i = inbox.messages[0].id;
  expect(
    (await json(await call("/v1/messages/" + i, box.token))).content.text,
  ).toContain("Hello world");
  expect(await (await call(`/v1/messages/${i}/raw`, box.token)).text()).toBe(
    raw,
  );
  const other = await json(
    await call("/v1/admin/agents", "test-owner", { name: "other" }),
  );
  const otherbox = await json(
    await call("/v1/mailboxes", other.token, { name: "other" }),
  );
  expect((await call("/v1/messages/" + i, otherbox.token)).status).toBe(404);
  await call("/v1/messages/" + i, box.token, undefined, "DELETE");
  expect((await call("/v1/messages/" + i, box.token)).status).toBe(404);
});
it("rejects unknown recipients and oversized email", async () => {
  for (const [to, size] of [
    ["unknown@agents.example.com", 1],
    [box.address, 6 * 1024 * 1024],
  ] as const) {
    const reject = vi.fn();
    await worker.email({ to, rawSize: size, setReject: reject } as any, e);
    expect(reject).toHaveBeenCalledOnce();
  }
});
it("sends idempotently, detects conflicts and applies quota", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "provider-1" });
  e.EMAIL = { send };
  const b = { to: ["human@example.net"], subject: "Hello", text: "world" };
  const first = await json(
    await call("/v1/send", box.token, b, "POST", { "Idempotency-Key": "one" }),
  );
  expect(first.status).toBe("accepted");
  await call("/v1/send", box.token, b, "POST", { "Idempotency-Key": "one" });
  expect(send).toHaveBeenCalledOnce();
  expect(
    (
      await call("/v1/send", box.token, { ...b, text: "changed" }, "POST", {
        "Idempotency-Key": "one",
      })
    ).status,
  ).toBe(409);
  const results = await Promise.all(
    ["two", "three"].map((k) =>
      call("/v1/send", box.token, b, "POST", { "Idempotency-Key": k }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
  delete e.EMAIL;
});
it("recovers pending raw storage without losing polling visibility", async () => {
  await e.DB.prepare(
    "INSERT INTO messages(id,mailbox,direction,status,created,object_key) VALUES('recover',?,'incoming','pending',0,'recover')",
  )
    .bind(box.id)
    .run();
  await e.MAIL.put("recover", "hello");
  const before = await json(await call("/v1/messages", box.token));
  await cleanup(e);
  const after = await json(
    await call(`/v1/messages?after=${before.nextCursor}`, box.token),
  );
  expect(after.messages.some((r: any) => r.id === "recover")).toBe(true);
});
it("disabling an agent revokes descendant access", async () => {
  await call("/v1/admin/agents/" + agent.id, "test-owner", undefined, "DELETE");
  expect((await call("/v1/messages", box.token)).status).toBe(401);
  expect((await call("/v1/mailboxes", agent.token)).status).toBe(401);
});
