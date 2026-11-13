import { z } from 'zod'

export const MESSAGE_CEILING_BYTES = 5 * 1024 * 1024
export const OUTBOUND_ALLOWANCE_BYTES = 16 * 1024
export const REQUEST_BODY_BYTES = 8 * 1024 * 1024
export const MAX_RECIPIENTS = 50
export const MAX_ATTACHMENTS = 32
export const mailboxLimitSchema = z.number().int().min(1).max(1000)
export const dailyLimitSchema = z.number().int().min(1).max(100000)
export const configSchema = z.strictObject({
  mailDomain: z
    .string()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  sendingEnabled: z.boolean().default(false),
  retentionDays: z
    .number()
    .int()
    .min(0)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 86400000))
    .default(0),
  maxMessageMiB: z.number().int().min(1).max(5).default(5),
  defaults: z
    .strictObject({
      mailboxesPerIdentity: mailboxLimitSchema.default(10),
      dailyRecipientsPerMailbox: dailyLimitSchema.default(100),
    })
    .default({ mailboxesPerIdentity: 10, dailyRecipientsPerMailbox: 100 }),
})
export type Configuration = z.infer<typeof configSchema>
export type PolicyBindings = {
  MAIL_DOMAIN: string
  RETENTION_DAYS?: string
  MAILBOX_LIMIT?: string
  DAILY_LIMIT?: string
  MAX_MESSAGE_MIB?: string
}

export function runtimeConfig(env: PolicyBindings): Configuration {
  return configSchema.parse({
    mailDomain: env.MAIL_DOMAIN,
    retentionDays:
      env.RETENTION_DAYS === undefined ? undefined : Number(env.RETENTION_DAYS),
    maxMessageMiB:
      env.MAX_MESSAGE_MIB === undefined
        ? undefined
        : Number(env.MAX_MESSAGE_MIB),
    defaults: {
      mailboxesPerIdentity:
        env.MAILBOX_LIMIT === undefined ? undefined : Number(env.MAILBOX_LIMIT),
      dailyRecipientsPerMailbox:
        env.DAILY_LIMIT === undefined ? undefined : Number(env.DAILY_LIMIT),
    },
  })
}
