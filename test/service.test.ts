import { beforeAll, expect, it, vi } from "vitest"
import worker, { cleanup } from "../src/index"
import migration from "../migrations/0001.sql?raw"
import {
  bindings as environment,
  call as request,
  json,
  credentialSchema,
  mailboxCredentialSchema,
  attemptSchema,
  listSchema,
  detailSchema,
  incomingMessage,
  mockSend,
  type Credential,
  type MailboxCredential,
} from "./helpers"
const call = (
  path: string,
  token: string,
  data?: unknown,
  method = data ? "POST" : "GET",
  headers: Record<string, string> = {},
) => request(path, token, data, method, environment, headers)
let agent: Credential, mailbox: MailboxCredential
beforeAll(async () => {
  await environment.DB.exec(
    migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "),
  )
  agent = await json(
    await call("/v1/admin/agents", "test-owner", {
      name: "test",
      mailboxLimit: 2,
      dailyLimit: 2,
    }),
    credentialSchema,
  )
  mailbox = await json(
    await call("/v1/mailboxes", agent.token, { name: "alpha" }),
    mailboxCredentialSchema,
  )
})
it("isolates roles and atomically limits mailbox creation", async () => {
  expect((await call("/v1/messages", agent.token)).status).toBe(403)
  const results = await Promise.all(
    ["beta", "gamma"].map((name) =>
      call("/v1/mailboxes", agent.token, { name }),
    ),
  )
  expect(results.map((message) => message.status).sort()).toEqual([201, 429])
  expect((await call("/v1/admin/agents", mailbox.token)).status).toBe(403)
})
it("stores, deduplicates, parses, polls and deletes MIME", async () => {
  const raw =
    "From: Human <human@example.net>\r\nTo: alpha@agents.example.com\r\nSubject: Hello\r\nMessage-ID: <a@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world"
  const incoming = () =>
    incomingMessage({
      from: "human@example.net",
      to: mailbox.address,
      rawSize: raw.length,
      raw: new Blob([raw]).stream(),
      headers: new Headers({ subject: "Hello" }),
      setReject: vi.fn(),
    })
  await worker.email(incoming(), environment)
  await worker.email(incoming(), environment)
  const inbox = await json(
    await call("/v1/messages", mailbox.token),
    listSchema,
  )
  expect(inbox.messages).toHaveLength(1)
  const messageId = inbox.messages[0].id
  expect(
    (
      await json(
        await call("/v1/messages/" + messageId, mailbox.token),
        detailSchema,
      )
    ).content.text,
  ).toContain("Hello world")
  expect(
    new TextDecoder().decode(
      await (
        await call(`/v1/messages/${messageId}/raw`, mailbox.token)
      ).arrayBuffer(),
    ),
  ).toBe(raw)
  const other = await json(
    await call("/v1/admin/agents", "test-owner", { name: "other" }),
    credentialSchema,
  )
  const otherbox = await json(
    await call("/v1/mailboxes", other.token, { name: "other" }),
    mailboxCredentialSchema,
  )
  expect((await call("/v1/messages/" + messageId, otherbox.token)).status).toBe(
    404,
  )
  await call("/v1/messages/" + messageId, mailbox.token, undefined, "DELETE")
  expect((await call("/v1/messages/" + messageId, mailbox.token)).status).toBe(
    404,
  )
})
it("rejects unknown recipients and oversized email", async () => {
  for (const [to, size] of [
    ["unknown@agents.example.com", 1],
    [mailbox.address, 6 * 1024 * 1024],
  ] as const) {
    const reject = vi.fn()
    await worker.email(
      incomingMessage({ to, rawSize: size, setReject: reject }),
      environment,
    )
    expect(reject).toHaveBeenCalledOnce()
  }
})
it("sends idempotently, detects conflicts and applies quota", async () => {
  const send = mockSend().mockResolvedValue({ messageId: "provider-1" })
  environment.EMAIL = { send }
  const sendInput = {
    to: ["human@example.net"],
    subject: "Hello",
    text: "world",
  }
  const first = await json(
    await call("/v1/send", mailbox.token, sendInput, "POST", {
      "Idempotency-Key": "one",
    }),
    attemptSchema,
  )
  expect(first.status).toBe("accepted")
  await call("/v1/send", mailbox.token, sendInput, "POST", {
    "Idempotency-Key": "one",
  })
  expect(send).toHaveBeenCalledOnce()
  expect(
    (
      await call(
        "/v1/send",
        mailbox.token,
        { ...sendInput, text: "changed" },
        "POST",
        {
          "Idempotency-Key": "one",
        },
      )
    ).status,
  ).toBe(409)
  const results = await Promise.all(
    ["two", "three"].map((k) =>
      call("/v1/send", mailbox.token, sendInput, "POST", {
        "Idempotency-Key": k,
      }),
    ),
  )
  expect(results.map((message) => message.status).sort()).toEqual([201, 429])
  delete environment.EMAIL
})
it("recovers pending raw storage without losing polling visibility", async () => {
  await environment.DB.prepare(
    "INSERT INTO messages(id,mailbox,direction,status,created,object_key) VALUES('recover',?,'incoming','pending',0,'recover')",
  )
    .bind(mailbox.id)
    .run()
  await environment.MAIL.put("recover", "hello")
  const before = await json(
    await call("/v1/messages", mailbox.token),
    listSchema,
  )
  await cleanup(environment)
  const after = await json(
    await call(`/v1/messages?after=${before.nextCursor}`, mailbox.token),
    listSchema,
  )
  expect(after.messages.some((message) => message.id === "recover")).toBe(true)
})
it("disabling an agent revokes descendant access", async () => {
  await call("/v1/admin/agents/" + agent.id, "test-owner", undefined, "DELETE")
  expect((await call("/v1/messages", mailbox.token)).status).toBe(401)
  expect((await call("/v1/mailboxes", agent.token)).status).toBe(401)
})
