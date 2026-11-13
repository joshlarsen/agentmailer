import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { vi, type Mock } from 'vitest'
import { z } from 'zod'

import worker, { type Env } from '../src/index'

declare global {
  namespace Cloudflare {
    interface Env extends TestBindings {}
  }
}
type TestBindings = Env
export const bindings: Env = { ...env }
export const credentialSchema = z.object({ id: z.string(), token: z.string() })
export const mailboxCredentialSchema = credentialSchema.extend({
  address: z.string(),
  keyId: z.string(),
})
export const attemptSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'accepted', 'failed', 'uncertain']),
})
export const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })),
  nextCursor: z.number(),
})
export const detailSchema = z.object({
  content: z.object({
    text: z.string().optional(),
    attachments: z.array(z.object({ content: z.unknown().optional() })),
  }),
})
export type Credential = z.infer<typeof credentialSchema>
export type MailboxCredential = z.infer<typeof mailboxCredentialSchema>

export async function json<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const value: unknown = await response.json()
  return schema.parse(value)
}

export async function call(
  path: string,
  token: string,
  data?: unknown,
  method = data ? 'POST' : 'GET',
  environment: Env = bindings,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request('https://mail.test' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    environment,
    createExecutionContext(),
  )
}

export function incomingMessage(
  overrides: Partial<ForwardableEmailMessage> = {},
): ForwardableEmailMessage {
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  return {
    from: 'human@example.net',
    to: 'unknown@example.com',
    raw,
    rawSize: 0,
    headers: new Headers(),
    canBeForwarded: false,
    setReject: vi.fn(),
    forward: vi.fn<ForwardableEmailMessage['forward']>(),
    reply:
      vi.fn<
        (
          message: EmailMessage | EmailReplyMessageBuilder,
        ) => Promise<EmailSendResult>
      >(),
    ...overrides,
  }
}

export function mockSend(): Mock<
  (message: EmailMessage | EmailMessageBuilder) => Promise<EmailSendResult>
> {
  return vi.fn<
    (message: EmailMessage | EmailMessageBuilder) => Promise<EmailSendResult>
  >()
}

// Bind native methods to the original runtime object; spread loses their receivers.
export function overrideMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
): T {
  return new Proxy(target, {
    get(object, property) {
      if (property === key) return replacement
      const value: unknown = Reflect.get(object, property, object)
      return typeof value === 'function' ? value.bind(object) : value
    },
  })
}
