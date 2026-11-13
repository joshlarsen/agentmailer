import { createExecutionContext } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { z } from 'zod'

import worker from '../src/index'
import { bindings, json } from './helpers'

const operationSchema = z.object({
  operationId: z.string(),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  responses: z.record(z.string(), z.unknown()),
})
const specSchema = z.object({
  openapi: z.literal('3.1.0'),
  servers: z.array(z.object({ url: z.string() })),
  paths: z.record(z.string(), z.record(z.string(), operationSchema)),
})

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://mail.test${path}`, init),
    bindings,
    createExecutionContext(),
  )
}

it('serves a public deployment-relative contract generated from registered routes', async () => {
  const response = await request('/openapi.json')
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('application/json')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const spec = await json(response, specSchema)
  expect(spec.servers).toEqual([{ url: '/' }])
  expect(
    Object.fromEntries(
      Object.entries(spec.paths).map(([path, methods]) => [
        path,
        Object.keys(methods).sort(),
      ]),
    ),
  ).toEqual({
    '/health': ['get'],
    '/agents': ['get', 'post'],
    '/agents/{id}': ['delete'],
    '/mailboxes': ['get', 'post'],
    '/mailboxes/{id}': ['delete'],
    '/mailboxes/{id}/keys': ['post'],
    '/mailboxes/{id}/keys/{key}': ['delete'],
    '/messages': ['get'],
    '/messages/{id}': ['delete', 'get', 'patch'],
    '/messages/{id}/raw': ['get'],
    '/messages/{id}/attachments/{index}': ['get'],
    '/send': ['post'],
    '/messages/{id}/reply': ['post'],
  })
  const ids = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const operation of Object.values(methods)) {
      ids.push(operation.operationId)
      expect(operation.security).toEqual(
        path === '/health' ? [] : [{ bearerAuth: [] }],
      )
    }
  }
  expect(new Set(ids).size).toBe(ids.length)
  expect(await json(await request('/openapi.json'), specSchema)).toEqual(spec)
})

it('keeps public discovery separate from protected resources and retired URLs', async () => {
  expect((await request('/health')).status).toBe(200)
  for (const path of [
    '/agents',
    '/mailboxes',
    '/messages',
    '/send',
    '/messages/example/raw',
  ]) {
    const response = await request(path, {
      method: path === '/send' ? 'POST' : 'GET',
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'unauthorized' } })
  }
  for (const path of ['/v1/messages', '/v1/admin/agents', '/admin/agents']) {
    expect((await request(path)).status).toBe(404)
  }
})
