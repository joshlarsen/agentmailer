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
  overrideMethod,
  type Credential,
  type MailboxCredential,
} from "./helpers"
import type { MessageRow } from "../src/index"
const call = request
let agent: Credential, mailbox: MailboxCredential
beforeAll(async () => {
  await environment.DB.exec(
    migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "),
  )
  agent = await json(
    await call("/v1/admin/agents", "test-owner", { name: "faults" }),
    credentialSchema,
  )
  mailbox = await json(
    await call("/v1/mailboxes", agent.token, { name: "faults" }),
    mailboxCredentialSchema,
  )
})
const payload = { to: ["human@example.net"], subject: "Status", text: "Hello" }
it("never resends after a provider timeout, including concurrent retries", async () => {
  const send = mockSend().mockRejectedValue(new Error("timeout"))
  const bindings = { ...environment, EMAIL: { send } }
  const headers = { "Idempotency-Key": "timeout" }
  const responses = await Promise.all([
    call("/v1/send", mailbox.token, payload, "POST", bindings, headers),
    call("/v1/send", mailbox.token, payload, "POST", bindings, headers),
  ])
  expect(send).toHaveBeenCalledOnce()
  const retry = await json(
    await call("/v1/send", mailbox.token, payload, "POST", bindings, headers),
    attemptSchema,
  )
  expect(retry.status).toBe("uncertain")
  expect(responses.some((message) => message.status === 502)).toBe(true)
  expect(send).toHaveBeenCalledOnce()
})
it("records known provider rejection", async () => {
  const send = mockSend().mockRejectedValue(
    Object.assign(new Error("rejected"), { code: "E_RECIPIENT_SUPPRESSED" }),
  )
  const response = await json(
    await call(
      "/v1/send",
      mailbox.token,
      payload,
      "POST",
      { ...environment, EMAIL: { send } },
      { "Idempotency-Key": "rejected" },
    ),
    attemptSchema,
  )
  expect(response.status).toBe("failed")
})
it("retains uncertainty when persisting provider acceptance fails", async () => {
  const send = mockSend().mockResolvedValue({ messageId: "accepted" })
  const faultyDB = overrideMethod(
    environment.DB,
    "prepare",
    function (sql: string) {
      if (sql.includes("status='accepted'")) throw new Error("database down")
      return environment.DB.prepare(sql)
    },
  )
  const bindings = { ...environment, EMAIL: { send }, DB: faultyDB }
  const headers = { "Idempotency-Key": "acceptance-write-failure" }
  expect(
    (await call("/v1/send", mailbox.token, payload, "POST", bindings, headers))
      .status,
  ).toBe(500)
  const retry = await json(
    await call(
      "/v1/send",
      mailbox.token,
      payload,
      "POST",
      { ...environment, EMAIL: { send } },
      headers,
    ),
    attemptSchema,
  )
  expect(retry.status).toBe("uncertain")
  expect(send).toHaveBeenCalledOnce()
})
it("exposes raw and multipart attachment downloads and threads replies", async () => {
  const raw =
    'From: Human <human@example.net>\r\nReply-To: reply@example.net\r\nSubject: Unicode ✓\r\nMessage-ID: <multipart@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello ✓\r\n--x\r\nContent-Type: application/octet-stream; name="test.txt"\r\nContent-Disposition: attachment; filename="test.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--'
  await worker.email(
    incomingMessage({
      from: "envelope@example.net",
      to: mailbox.address,
      rawSize: new TextEncoder().encode(raw).length,
      raw: new Blob([raw]).stream(),
      headers: new Headers(),
      setReject: vi.fn(),
    }),
    environment,
  )
  const list = await json(
    await call("/v1/messages?direction=incoming", mailbox.token),
    listSchema,
  )
  const messageId = list.messages[0].id
  const detail = await json(
    await call("/v1/messages/" + messageId, mailbox.token),
    detailSchema,
  )
  expect(detail.content.text).toContain("✓")
  expect(detail.content.attachments[0].content).toBeUndefined()
  const attachment = await call(
    `/v1/messages/${messageId}/attachments/0`,
    mailbox.token,
  )
  expect(new TextDecoder().decode(await attachment.arrayBuffer())).toBe("hello")
  const send = mockSend().mockResolvedValue({ messageId: "reply" })
  expect(
    (
      await call(
        `/v1/messages/${messageId}/reply`,
        mailbox.token,
        { text: "Response" },
        "POST",
        { ...environment, EMAIL: { send } },
        { "Idempotency-Key": "reply" },
      )
    ).status,
  ).toBe(201)
  const sentMessage = send.mock.calls[0][0]
  expect(sentMessage.to).toEqual(["reply@example.net"])
  if (!("headers" in sentMessage))
    throw new Error("Expected structured message")
  expect(sentMessage.headers?.["In-Reply-To"]).toBe("<multipart@example.net>")
})
it("recovers raw content after a failed publication write", async () => {
  const raw = "From: a@example.net\r\n\r\nRecovery"
  const faultyDB = overrideMethod(
    environment.DB,
    "prepare",
    function (sql: string) {
      if (sql.includes("status='ready'")) throw new Error("database down")
      return environment.DB.prepare(sql)
    },
  )
  await expect(
    worker.email(
      incomingMessage({
        from: "a@example.net",
        to: mailbox.address,
        rawSize: raw.length,
        raw: new Blob([raw]).stream(),
        headers: new Headers(),
        setReject: vi.fn(),
      }),
      { ...environment, DB: faultyDB },
    ),
  ).rejects.toThrow()
  const row = await environment.DB.prepare(
    "SELECT * FROM messages WHERE direction='incoming' AND status='pending'",
  ).first<MessageRow>()
  if (!row) throw new Error("Expected pending message")
  expect(await environment.MAIL.head(row.object_key)).toBeTruthy()
  await environment.DB.prepare("UPDATE messages SET created=0 WHERE id=?")
    .bind(row.id)
    .run()
  await cleanup(environment)
  expect(
    (
      await environment.DB.prepare("SELECT status FROM messages WHERE id=?")
        .bind(row.id)
        .first<Pick<MessageRow, "status">>()
    )?.status,
  ).toBe("ready")
})
it("retries deletion and preserves cursor monotonicity after deleting all messages", async () => {
  const list = await json(await call("/v1/messages", mailbox.token), listSchema)
  const before = list.nextCursor
  const message = list.messages[0]
  const bad = {
    ...environment,
    MAIL: overrideMethod(environment.MAIL, "delete", async () => {
      throw new Error("R2 unavailable")
    }),
  }
  expect(
    (
      await call(
        "/v1/messages/" + message.id,
        mailbox.token,
        undefined,
        "DELETE",
        bad,
      )
    ).status,
  ).toBe(500)
  expect((await call("/v1/messages/" + message.id, mailbox.token)).status).toBe(
    404,
  )
  await cleanup(environment)
  expect(
    await environment.DB.prepare("SELECT id FROM messages WHERE id=?")
      .bind(message.id)
      .first(),
  ).toBeNull()
  await environment.DB.prepare("UPDATE messages SET created=0").run()
  await cleanup({ ...environment, RETENTION_DAYS: "1" })
  const send = mockSend().mockResolvedValue({ messageId: "after-deletion" })
  await call(
    "/v1/send",
    mailbox.token,
    payload,
    "POST",
    { ...environment, EMAIL: { send } },
    { "Idempotency-Key": "after-deletion" },
  )
  const after = await json(
    await call(`/v1/messages?after=${before}`, mailbox.token),
    listSchema,
  )
  expect(after.messages).toHaveLength(1)
  expect(after.nextCursor).toBeGreaterThan(before)
})
it("revokes only the selected mailbox credential", async () => {
  const replacement = await json(
    await call(`/v1/mailboxes/${mailbox.id}/keys`, agent.token, {}, "POST"),
    credentialSchema,
  )
  await call(
    `/v1/mailboxes/${mailbox.id}/keys/${mailbox.keyId}`,
    agent.token,
    undefined,
    "DELETE",
  )
  expect((await call("/v1/messages", mailbox.token)).status).toBe(401)
  expect((await call("/v1/messages", replacement.token)).status).toBe(200)
})

it("translates address collisions without hiding database failures", async () => {
  const duplicate = await call("/v1/mailboxes", agent.token, {
    name: "faults",
  })
  expect(duplicate.status).toBe(409)
  const faultyDatabase = overrideMethod(
    environment.DB,
    "prepare",
    function (sql: string) {
      if (sql.startsWith("INSERT INTO mailboxes"))
        throw new Error("database unavailable")
      return environment.DB.prepare(sql)
    },
  )
  const failed = await call(
    "/v1/mailboxes",
    agent.token,
    { name: "unavailable" },
    "POST",
    { ...environment, DB: faultyDatabase },
  )
  expect(failed.status).toBe(500)
})

it("keeps cache storage failures separate from MIME parsing failures", async () => {
  const raw = "From: human@example.net\r\n\r\nCache failure"
  await worker.email(
    incomingMessage({
      to: mailbox.address,
      rawSize: raw.length,
      raw: new Blob([raw]).stream(),
    }),
    environment,
  )
  const row = await environment.DB.prepare(
    "SELECT * FROM messages WHERE mailbox=? AND direction='incoming' ORDER BY seq DESC LIMIT 1",
  )
    .bind(mailbox.id)
    .first<MessageRow>()
  if (!row) throw new Error("Expected incoming message")
  const faultyBucket = overrideMethod(environment.MAIL, "put", async () => {
    throw new Error("R2 unavailable")
  })
  const response = await call(
    `/v1/messages/${row.id}`,
    (
      await json(
        await call(`/v1/mailboxes/${mailbox.id}/keys`, agent.token, {}),
        credentialSchema,
      )
    ).token,
    undefined,
    "GET",
    { ...environment, MAIL: faultyBucket },
  )
  expect(response.status).toBe(500)
})

it("recognizes idempotency hashes persisted before the type cleanup", async () => {
  const send = mockSend().mockResolvedValue({ messageId: "should-not-send" })
  const requestHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({ b: payload, headers: undefined }),
        ),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")
  await environment.DB.prepare(
    "INSERT INTO messages(id,mailbox,direction,status,created,object_key,idem,request_hash) VALUES('legacy-attempt',?,'outgoing','uncertain',?,'legacy','legacy',?)",
  )
    .bind(mailbox.id, Date.now(), requestHash)
    .run()
  const credential = await json(
    await call(`/v1/mailboxes/${mailbox.id}/keys`, agent.token, {}),
    credentialSchema,
  )
  const response = await call(
    "/v1/send",
    credential.token,
    payload,
    "POST",
    { ...environment, EMAIL: { send } },
    { "Idempotency-Key": "legacy" },
  )
  expect(response.status).toBe(200)
  expect((await json(response, attemptSchema)).status).toBe("uncertain")
  expect(send).not.toHaveBeenCalled()
})
