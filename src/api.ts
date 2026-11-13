import { resolver } from 'hono-openapi'
import { z } from 'zod'

import { mailboxLimitSchema, dailyLimitSchema, MAX_ATTACHMENTS } from './config'

export const agentSchema = z.object({
  name: z.string().min(1).max(100),
  mailboxLimit: mailboxLimitSchema.optional(),
  dailyLimit: dailyLimitSchema.optional(),
})
export const mailboxSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
})
export const readSchema = z.object({ read: z.boolean() })
const address = z
  .email()
  .max(320)
  .refine((s) => !/[\r\n]/.test(s))
export const sendSchema = z
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
      .max(MAX_ATTACHMENTS)
      .optional(),
  })
  .refine((b) => !!(b.text || b.html))
  .describe(
    'Requires nonempty text or html. JSON plus 16 KiB must fit the configured message limit (default 5 MiB). Maximum 50 recipients across to/cc/bcc. No CR or LF in addresses, subject, name, or attachment filename/type.',
  )

const errorSchema = z.object({ error: z.object({ code: z.string() }) })
const mailboxResponse = z.object({
  id: z.string(),
  agent: z.string(),
  address: z.string(),
  disabled: z.number().int(),
})
const messageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  direction: z.enum(['incoming', 'outgoing']),
  status: z.enum(['ready', 'pending', 'accepted', 'failed', 'uncertain']),
  created: z.number().int().describe('Unix milliseconds'),
  subject: z.string().nullable(),
  sender: z.string().nullable(),
  recipient: z.string().nullable(),
  read: z.number().int(),
  provider_id: z.string().nullable(),
  error: z.string().nullable(),
})
const sendResult = z.object({
  id: z.string(),
  status: z.enum(['pending', 'accepted', 'failed', 'uncertain']),
  provider_id: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
})
const messageDetail = messageSchema.extend({
  mailbox: z.string(),
  idem: z.string().nullable(),
  content: z
    .looseObject({
      attachments: z.array(z.looseObject({ id: z.number().int() })).optional(),
    })
    .describe(
      'Parsed incoming PostalMime fields or outgoing JSON. Attachment bytes omitted.',
    ),
})
export const securitySchemes = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
} as const

export const healthSchema = z.object({ ok: z.literal(true) })
export const replySchema = z
  .object({
    cc: sendSchema.shape.cc,
    bcc: sendSchema.shape.bcc,
    subject: sendSchema.shape.subject.optional(),
    text: sendSchema.shape.text,
    html: sendSchema.shape.html,
    name: sendSchema.shape.name,
    attachments: sendSchema.shape.attachments,
  })
  .refine((body) => !!(body.text || body.html))
  .describe(
    'Requires nonempty text or html. Recipient and threading derive from the incoming message; subject is optional. Same size and recipient limits as sending.',
  )
export const mailboxListSchema = z.array(mailboxResponse)
export const messageListSchema = z.object({
  messages: z.array(messageSchema),
  nextCursor: z.number().int(),
})
const errorResponses = {
  400: {
    description: 'Invalid request',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  401: {
    description: 'Invalid credential',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  403: {
    description: 'Wrong credential role',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  404: {
    description: 'Not found or inaccessible',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  409: {
    description: 'Conflict or sending disabled',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  413: {
    description: 'Message too large',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  429: {
    description: 'Usage limit',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  500: {
    description: 'Internal or storage error',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  502: {
    description: 'Provider failure or uncertain send outcome',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  422: {
    description: 'Parsing failed; download raw content instead',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
  503: {
    description: 'Content unavailable',
    content: { 'application/json': { schema: resolver(errorSchema) } },
  },
}

export {
  resolver,
  errorSchema,
  mailboxResponse,
  messageSchema,
  messageDetail,
  sendResult,
}

export function routeErrors(
  ...codes: (keyof typeof errorResponses)[]
): Partial<typeof errorResponses> {
  return Object.fromEntries(codes.map((code) => [code, errorResponses[code]]))
}
