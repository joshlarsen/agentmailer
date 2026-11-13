import { expect, it } from 'vitest'

import { configSchema, runtimeConfig } from '../src/config'

it('shares defaults and rejects invalid configuration', () => {
  const minimal = { mailDomain: 'agents.example.com' }
  expect(runtimeConfig({ MAIL_DOMAIN: minimal.mailDomain })).toEqual(
    configSchema.parse(minimal),
  )
  for (const patch of [
    { maxMessageMiB: 0 },
    { maxMessageMiB: 6 },
    { maxMessageMiB: 1.5 },
    { retentionDays: -1 },
    { retentionDays: '30' },
    { unknown: true },
    { defaults: { mailboxesPerIdentity: 1001 } },
    { defaults: { dailyRecipientsPerMailbox: 100001 } },
  ])
    expect(configSchema.safeParse({ ...minimal, ...patch }).success).toBe(false)
  expect(
    configSchema.parse({ ...minimal, maxMessageMiB: 1 }).maxMessageMiB,
  ).toBe(1)
  expect(() =>
    runtimeConfig({
      MAIL_DOMAIN: minimal.mailDomain,
      RETENTION_DAYS: 'invalid',
    }),
  ).toThrow()
})
