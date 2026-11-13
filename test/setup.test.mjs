import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { test } from 'node:test'

const script = resolve('scripts/setup.mjs')
const savedState = {
  account: 'a'.repeat(32),
  domain: 'agents.example.com',
  name: 'test-mail',
  retention: '30',
  sending: true,
}
function fixture(t, { state = savedState, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentmailer-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  copyFileSync(resolve('test/fixtures/wrangler.cjs'), join(root, 'bin/npx'))
  chmodSync(join(root, 'bin/npx'), 0o755)
  if (state !== null)
    writeFileSync(
      join(root, '.deployment.json'),
      typeof state === 'string' ? state : JSON.stringify(state),
    )
  const calls = () =>
    existsSync(join(root, 'calls'))
      ? readFileSync(join(root, 'calls'), 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse)
      : []
  const readState = () =>
    JSON.parse(readFileSync(join(root, '.deployment.json'), 'utf8'))
  const invoke = (args = [], answers = [], overrides = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: {
          ...process.env,
          ...env,
          ...overrides,
          PATH: join(root, 'bin') + delimiter + process.env.PATH,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = '',
        answered = 0
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Setup timed out: ' + stdout + stderr))
      }, 10000)
      child.on('error', reject)
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk
        const next = answers[answered]
        if (next && stdout.includes(next[0])) {
          child.stdin.write(next[1] + '\n')
          answered++
        }
      })
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        resolve({ code, stdout, stderr })
      })
    })
  return { root, calls, readState, invoke }
}

test('setup resumes resources and secret; upgrade and doctor reuse deployment', async (t) => {
  const f = fixture(t)
  for (const args of [[], ['--upgrade'], ['--doctor']]) {
    const result = await f.invoke(args)
    assert.equal(result.code, 0, result.stderr)
  }
  const commands = f.calls().map((call) => call.args)
  assert.equal(
    commands.filter((args) => args[0] === 'd1' && args[1] === 'create').length,
    1,
  )
  assert.equal(
    commands.filter((args) => args[0] === 'r2' && args[2] === 'create').length,
    1,
  )
  assert.equal(commands.filter((args) => args[0] === 'secret').length, 1)
  assert(f.calls().every((call) => call.account === savedState.account))
  const config = JSON.parse(
    readFileSync(join(f.root, 'wrangler.deploy.json'), 'utf8'),
  )
  assert.equal(config.d1_databases[0].database_id, 'database-id')
  assert.equal(config.vars.RETENTION_DAYS, '30')
  assert.equal(config.send_email[0].name, 'EMAIL')
  assert(
    commands.some(
      (args) => args.includes('execute') && args.includes('test-mail'),
    ),
  )
  assert.deepEqual(
    readdirSync(f.root).filter((name) => name.endsWith('.tmp')),
    [],
  )
  if (process.platform !== 'win32')
    assert.equal(statSync(join(f.root, '.deployment.json')).mode & 0o777, 0o600)
})

test('fresh receive-only setup collects settings without adding a sending binding', async (t) => {
  const f = fixture(t, { state: null })
  const result = await f.invoke(
    [],
    [
      ['Cloudflare account ID:', 'b'.repeat(32)],
      ['Dedicated mail domain/subdomain:', 'agents.example.com'],
      ['Enable sending?', 'n'],
      ['Retention days', '0'],
    ],
  )
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.readState().sending, false)
  assert.equal(f.readState().account, 'b'.repeat(32))
  const config = JSON.parse(
    readFileSync(join(f.root, 'wrangler.deploy.json'), 'utf8'),
  )
  assert.equal(config.send_email, undefined)
  assert(f.calls().some((call) => call.args[0] === 'login'))
})

test('malformed or invalid saved state stops before remote commands', async (t) => {
  for (const state of [
    '{broken',
    { ...savedState, sending: 'false' },
    { ...savedState, retention: '-1' },
  ]) {
    const f = fixture(t, { state })
    const before = readFileSync(join(f.root, '.deployment.json'), 'utf8')
    const result = await f.invoke()
    assert.equal(result.code, 1)
    assert.deepEqual(f.calls(), [])
    assert.equal(readFileSync(join(f.root, '.deployment.json'), 'utf8'), before)
  }
})

test('unsupported or conflicting options fail before any deployment work', async (t) => {
  const f = fixture(t)
  for (const args of [['--unknown'], ['--doctor', '--upgrade']]) {
    assert.equal((await f.invoke(args)).code, 1)
  }
  assert.deepEqual(f.calls(), [])
  const fresh = fixture(t, { state: null })
  assert.equal((await fresh.invoke(['--upgrade'])).code, 1)
  assert.equal((await fresh.invoke(['--doctor'])).code, 1)
  assert.deepEqual(fresh.calls(), [])
})

test('migration failure saves provisioned resources for the next run', async (t) => {
  const f = fixture(t)
  const failed = await f.invoke([], [], { FAKE_FAIL: 'd1 migrations apply' })
  assert.equal(failed.code, 1)
  assert.match(failed.stderr, /Wrangler d1 migrations failed/)
  assert.equal(f.readState().db, 'database-id')
  assert.equal(f.readState().bucket, true)
  assert.equal(f.readState().secret, undefined)
  const resumed = await f.invoke()
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(
    f
      .calls()
      .filter((call) => call.args[0] === 'd1' && call.args[1] === 'create')
      .length,
    1,
  )
  assert.equal(
    f
      .calls()
      .filter((call) => call.args[0] === 'r2' && call.args[2] === 'create')
      .length,
    1,
  )
})

test('unexpected database list output fails without creating resources', async (t) => {
  const f = fixture(t, { env: { FAKE_BAD_DATABASES: '1' } })
  assert.equal((await f.invoke()).code, 1)
  assert.equal(
    f.calls().some((call) => call.args.includes('create')),
    false,
  )
  assert.equal(f.readState().db, undefined)
})

test('bucket failure only offers reuse after confirming existence', async (t) => {
  const failed = fixture(t, { env: { FAKE_FAIL: 'r2 bucket' } })
  const result = await failed.invoke()
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.stdout, /Is it owned/)
  assert.equal(failed.readState().bucket, undefined)
  const existing = fixture(t, { env: { FAKE_BUCKET_EXISTS: '1' } })
  const reused = await existing.invoke(
    [],
    [['Is it owned by this deployment?', 'y']],
  )
  assert.equal(reused.code, 0, reused.stderr)
  assert.equal(existing.readState().bucket, true)
})

test('declining bucket reuse preserves the incomplete state', async (t) => {
  const f = fixture(t, { env: { FAKE_BUCKET_EXISTS: '1' } })
  const result = await f.invoke([], [['Is it owned by this deployment?', 'n']])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /reuse declined/)
  assert.equal(f.readState().bucket, undefined)
  assert.equal(
    f.calls().some((call) => call.args[0] === 'deploy'),
    false,
  )
})

test('deployment failure after installing the owner secret preserves it on resume', async (t) => {
  const f = fixture(t)
  const failed = await f.invoke([], [], { FAKE_FAIL: 'deploy' })
  assert.equal(failed.code, 1)
  assert.equal(f.readState().secret, true)
  const resumed = await f.invoke()
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(f.calls().filter((call) => call.args[0] === 'secret').length, 1)
})
