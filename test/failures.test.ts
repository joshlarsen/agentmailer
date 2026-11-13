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
  bindings = e,
  extra = {},
) =>
  worker.fetch(
    new Request("https://test" + path, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    bindings,
    {} as any,
  );
const json = async (r: Response) => (await r.json()) as any;
let agent: any, box: any;
beforeAll(async () => {
  await e.DB.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  agent = await json(
    await call("/v1/admin/agents", "test-owner", { name: "faults" }),
  );
  box = await json(
    await call("/v1/mailboxes", agent.token, { name: "faults" }),
  );
});
const payload = { to: ["human@example.net"], subject: "Status", text: "Hello" };
it("never resends after a provider timeout, including concurrent retries", async () => {
  const send = vi.fn().mockRejectedValue(new Error("timeout"));
  const bindings = { ...e, EMAIL: { send } };
  const headers = { "Idempotency-Key": "timeout" };
  const responses = await Promise.all([
    call("/v1/send", box.token, payload, "POST", bindings, headers),
    call("/v1/send", box.token, payload, "POST", bindings, headers),
  ]);
  expect(send).toHaveBeenCalledOnce();
  const retry = await json(
    await call("/v1/send", box.token, payload, "POST", bindings, headers),
  );
  expect(retry.status).toBe("uncertain");
  expect(responses.some((r) => r.status === 502)).toBe(true);
  expect(send).toHaveBeenCalledOnce();
});
it("records known provider rejection", async () => {
  const send = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("rejected"), { code: "E_RECIPIENT_SUPPRESSED" }),
    );
  const response = await json(
    await call(
      "/v1/send",
      box.token,
      payload,
      "POST",
      { ...e, EMAIL: { send } },
      { "Idempotency-Key": "rejected" },
    ),
  );
  expect(response.status).toBe("failed");
});
it("retains uncertainty when persisting provider acceptance fails", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const faultyDB = {
    prepare(sql: string) {
      if (sql.includes("status='accepted'")) throw new Error("database down");
      return e.DB.prepare(sql);
    },
  };
  const bindings = { ...e, EMAIL: { send }, DB: faultyDB };
  const headers = { "Idempotency-Key": "acceptance-write-failure" };
  expect(
    (await call("/v1/send", box.token, payload, "POST", bindings, headers))
      .status,
  ).toBe(500);
  const retry = await json(
    await call(
      "/v1/send",
      box.token,
      payload,
      "POST",
      { ...e, EMAIL: { send } },
      headers,
    ),
  );
  expect(retry.status).toBe("uncertain");
  expect(send).toHaveBeenCalledOnce();
});
it("exposes raw and multipart attachment downloads and threads replies", async () => {
  const raw =
    'From: Human <human@example.net>\r\nReply-To: reply@example.net\r\nSubject: Unicode ✓\r\nMessage-ID: <multipart@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello ✓\r\n--x\r\nContent-Type: application/octet-stream; name="test.txt"\r\nContent-Disposition: attachment; filename="test.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--';
  await worker.email(
    {
      from: "envelope@example.net",
      to: box.address,
      rawSize: new TextEncoder().encode(raw).length,
      raw: new Response(raw).body,
      headers: new Headers(),
      setReject: vi.fn(),
    } as any,
    e,
  );
  const list = await json(
    await call("/v1/messages?direction=incoming", box.token),
  );
  const i = list.messages[0].id;
  const detail = await json(await call("/v1/messages/" + i, box.token));
  expect(detail.content.text).toContain("✓");
  expect(detail.content.attachments[0].content).toBeUndefined();
  const attachment = await call(`/v1/messages/${i}/attachments/0`, box.token);
  expect(new TextDecoder().decode(await attachment.arrayBuffer())).toBe(
    "hello",
  );
  const send = vi.fn().mockResolvedValue({ messageId: "reply" });
  expect(
    (
      await call(
        `/v1/messages/${i}/reply`,
        box.token,
        { text: "Response" },
        "POST",
        { ...e, EMAIL: { send } },
        { "Idempotency-Key": "reply" },
      )
    ).status,
  ).toBe(201);
  expect(send.mock.calls[0][0].to).toEqual(["reply@example.net"]);
  expect(send.mock.calls[0][0].headers["In-Reply-To"]).toBe(
    "<multipart@example.net>",
  );
});
it("recovers raw content after a failed publication write", async () => {
  const raw = "From: a@example.net\r\n\r\nRecovery";
  const faultyDB = {
    prepare(sql: string) {
      if (sql.includes("status='ready'")) throw new Error("database down");
      return e.DB.prepare(sql);
    },
  };
  await expect(
    worker.email(
      {
        from: "a@example.net",
        to: box.address,
        rawSize: raw.length,
        raw: new Response(raw).body,
        headers: new Headers(),
        setReject: vi.fn(),
      } as any,
      { ...e, DB: faultyDB },
    ),
  ).rejects.toThrow();
  const row = await e.DB.prepare(
    "SELECT * FROM messages WHERE direction='incoming' AND status='pending'",
  ).first();
  expect(await e.MAIL.head(row.object_key)).toBeTruthy();
  await e.DB.prepare("UPDATE messages SET created=0 WHERE id=?")
    .bind(row.id)
    .run();
  await cleanup(e);
  expect(
    (
      await e.DB.prepare("SELECT status FROM messages WHERE id=?")
        .bind(row.id)
        .first()
    ).status,
  ).toBe("ready");
});
it("retries deletion and preserves cursor monotonicity after deleting all messages", async () => {
  const list = await json(await call("/v1/messages", box.token));
  const before = list.nextCursor;
  const r = list.messages[0];
  const bad = {
    ...e,
    MAIL: {
      delete: async () => {
        throw new Error("R2 unavailable");
      },
    },
  };
  expect(
    (await call("/v1/messages/" + r.id, box.token, undefined, "DELETE", bad))
      .status,
  ).toBe(500);
  expect((await call("/v1/messages/" + r.id, box.token)).status).toBe(404);
  await cleanup(e);
  expect(
    await e.DB.prepare("SELECT id FROM messages WHERE id=?").bind(r.id).first(),
  ).toBeNull();
  await e.DB.prepare("UPDATE messages SET created=0").run();
  await cleanup({ ...e, RETENTION_DAYS: "1" });
  const send = vi.fn().mockResolvedValue({ messageId: "after-deletion" });
  await call(
    "/v1/send",
    box.token,
    payload,
    "POST",
    { ...e, EMAIL: { send } },
    { "Idempotency-Key": "after-deletion" },
  );
  const after = await json(
    await call(`/v1/messages?after=${before}`, box.token),
  );
  expect(after.messages).toHaveLength(1);
  expect(after.nextCursor).toBeGreaterThan(before);
});
it("revokes only the selected mailbox credential", async () => {
  const replacement = await json(
    await call(`/v1/mailboxes/${box.id}/keys`, agent.token, {}, "POST"),
  );
  await call(
    `/v1/mailboxes/${box.id}/keys/${box.keyId}`,
    agent.token,
    undefined,
    "DELETE",
  );
  expect((await call("/v1/messages", box.token)).status).toBe(401);
  expect((await call("/v1/messages", replacement.token)).status).toBe(200);
});
