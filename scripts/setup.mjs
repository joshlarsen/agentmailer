import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { z } from 'zod'

const STATE_PATH = '.deployment.json'
const CONFIG_PATH = 'wrangler.deploy.json'
const accountSchema = z.string().regex(/^[a-f0-9]{32}$/)
const domainSchema = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)
const retentionSchema = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => Number.isSafeInteger(Number(value)))
const stateSchema = z.object({
  account: accountSchema,
  domain: domainSchema,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  retention: retentionSchema,
  sending: z.boolean(),
  db: z.string().min(1).optional(),
  bucket: z.boolean().optional(),
  secret: z.boolean().optional(),
})
const databaseListSchema = z.array(
  z.object({ name: z.string(), uuid: z.string().min(1) }),
)
const diagnosticConfigSchema = z.object({
  account_id: accountSchema,
  d1_databases: z.array(z.object({ database_name: z.string().min(1) })).min(1),
})

/** @typedef {z.infer<typeof stateSchema>} DeploymentState */

/** @param {unknown} error */
function isMissingFile(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function readJsonFile(path) {
  const text = await readFile(path, 'utf8').catch((error) => {
    if (isMissingFile(error)) return undefined
    throw error
  })
  if (text === undefined) return undefined
  // A malformed file must not be treated as an absent deployment.
  try {
    return JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error(
      `Invalid JSON in ${path}; fix the file before continuing.`,
      { cause: error },
    )
  }
}

/**
 * @param {string[]} args
 * @param {{ account?: string; capture?: boolean; input?: string }} options
 * @returns {Promise<string>}
 */
function runWrangler(args, { account, capture = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], {
      env: {
        ...process.env,
        ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}),
      },
      stdio: [
        input === undefined ? 'inherit' : 'pipe',
        capture ? 'pipe' : 'inherit',
        capture ? 'pipe' : 'inherit',
      ],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })

    child.once('error', (error) =>
      reject(
        new Error('Could not start Wrangler; check that npm is available.', {
          cause: error,
        }),
      ),
    )

    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new Error(
          `Wrangler ${args.slice(0, 2).join(' ')} failed (${signal ?? code}).${stderr.trim() ? ` ${stderr.trim()}` : ' Review the output above and rerun setup to resume.'}`,
        ),
      )
    })

    if (input !== undefined) {
      child.stdin?.on('error', (error) => {
        // An early child exit is reported by the close handler with its exit code.
        if (
          !(error instanceof Error && 'code' in error && error.code === 'EPIPE')
        )
          reject(error)
      })
      child.stdin?.end(input)
    }
  })
}

/** @param {DeploymentState} state */
async function saveState(state) {
  // Replace only after a complete write so interruption cannot truncate resume state.
  const temporaryPath = `${STATE_PATH}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporaryPath, STATE_PATH)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!isMissingFile(error)) throw error
    })
  }
}

async function collectSettings() {
  await runWrangler(['login'])
  await runWrangler(['whoami'])
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const account = accountSchema.parse(
      (await prompt.question('Cloudflare account ID: ')).trim(),
    )
    const domain = domainSchema.parse(
      (await prompt.question('Dedicated mail domain/subdomain: '))
        .trim()
        .toLowerCase(),
    )
    const sending =
      (await prompt.question('Enable sending? Requires Workers Paid (y/N): '))
        .trim()
        .toLowerCase() === 'y'
    const retention = retentionSchema.parse(
      (await prompt.question('Retention days (0 = forever): ')).trim() || '0',
    )
    return {
      account,
      domain,
      sending,
      retention,
      name: `agentmailer-${randomBytes(4).toString('hex')}`,
    }
  } finally {
    // Release stdin before invoking interactive child commands.
    prompt.close()
  }
}

/** @param {DeploymentState} state */
async function ensureDatabase(state) {
  if (state.db) return state.db

  const listDatabases = async () =>
    databaseListSchema.parse(
      JSON.parse(
        await runWrangler(['d1', 'list', '--json'], {
          account: state.account,
          capture: true,
        }),
      ),
    )

  const existing = (await listDatabases()).find(
    (database) => database.name === state.name,
  )
  if (existing) return existing.uuid
  await runWrangler(['d1', 'create', state.name, '--update-config=false'], {
    account: state.account,
  })
  const created = (await listDatabases()).find(
    (database) => database.name === state.name,
  )
  if (!created)
    throw new Error(
      'Could not resolve database ID; inspect wrangler d1 list and rerun setup.',
    )
  return created.uuid
}

/** @param {DeploymentState} state */
async function ensureBucket(state) {
  if (state.bucket) return

  await runWrangler(['r2', 'bucket', 'create', state.name], {
    account: state.account,
  }).catch(async (error) => {
    // Confirm the bucket exists before offering reuse; auth/service failures are not collisions.
    const output = await runWrangler(
      ['r2', 'bucket', 'info', state.name, '--json'],
      { account: state.account, capture: true },
    ).catch(() => {
      throw error
    })
    const bucket = z.object({ name: z.string() }).parse(JSON.parse(output))
    if (bucket.name !== state.name) throw error
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    try {
      const answer = await prompt.question(
        `Bucket ${state.name} already exists. Is it owned by this deployment? (y/N): `,
      )
      if (answer.trim().toLowerCase() !== 'y')
        throw new Error(
          'Bucket reuse declined. Review the saved deployment before rerunning setup.',
        )
    } finally {
      prompt.close()
    }
  })
}

/** @param {DeploymentState} state */
function buildConfig(state) {
  if (!state.db)
    throw new Error(
      'A database must be provisioned before generating configuration.',
    )
  return {
    name: state.name,
    account_id: state.account,
    main: 'src/index.ts',
    compatibility_date: '2026-11-13',
    vars: {
      MAIL_DOMAIN: state.domain,
      RETENTION_DAYS: state.retention,
      MAILBOX_LIMIT: '10',
      DAILY_LIMIT: '100',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: state.name,
        database_id: state.db,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'MAIL', bucket_name: state.name }],
    triggers: { crons: ['*/15 * * * *'] },
    ...(state.sending ? { send_email: [{ name: 'EMAIL' }] } : {}),
  }
}

/** @param {DeploymentState} state */
async function ensureOwnerSecret(state) {
  if (state.secret) return
  const secret = randomBytes(32).toString('hex')
  console.log(
    'Save this OWNER_TOKEN in your password manager (shown once):',
    secret,
  )
  await runWrangler(['secret', 'put', 'OWNER_TOKEN', '--config', CONFIG_PATH], {
    account: state.account,
    input: secret,
  })
  state.secret = true
  await saveState(state)
}

/** @param {DeploymentState} state */
function printNextSteps(state) {
  console.log(
    `In Cloudflare Email Service, enable routing for ${state.domain} and route catch-all to Worker ${state.name}. Do not replace existing MX records without reviewing conflicts.`,
  )
  if (state.sending)
    console.log('Onboard the same domain in Email Sending and verify DNS.')
  console.log(
    'Check the printed Worker URL /health; then follow README.md to create an agent and mailbox.',
  )
}

/** @param {boolean} upgrade */
async function deploy(upgrade) {
  const saved = await readJsonFile(STATE_PATH)
  if (saved === undefined && upgrade)
    throw new Error('No saved deployment. Run npm run setup first.')
  const state =
    saved === undefined ? await collectSettings() : stateSchema.parse(saved)
  await saveState(state)
  state.db = await ensureDatabase(state)
  await saveState(state)
  await ensureBucket(state)
  state.bucket = true
  await saveState(state)
  await writeFile(
    CONFIG_PATH,
    JSON.stringify(buildConfig(state), null, 2) + '\n',
  )
  await runWrangler(
    [
      'd1',
      'migrations',
      'apply',
      state.name,
      '--remote',
      '--config',
      CONFIG_PATH,
    ],
    { account: state.account },
  )
  await ensureOwnerSecret(state)
  await runWrangler(['deploy', '--config', CONFIG_PATH], {
    account: state.account,
  })
  printNextSteps(state)
}

async function diagnose() {
  const saved = await readJsonFile(CONFIG_PATH)
  if (saved === undefined) throw new Error('Run npm run setup first.')
  const config = diagnosticConfigSchema.parse(saved)
  await runWrangler(['whoami'], { account: config.account_id })
  await runWrangler(
    [
      'd1',
      'execute',
      config.d1_databases[0].database_name,
      '--remote',
      '--config',
      CONFIG_PATH,
      '--command',
      'SELECT count(*) AS messages FROM messages',
    ],
    { account: config.account_id },
  )
  console.log(
    'Verify /health, routing catch-all, R2 activation, and sending-domain status in the dashboard.',
  )
}

async function main() {
  const { values } = parseArgs({
    options: {
      doctor: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log('Usage: node scripts/setup.mjs [--upgrade | --doctor]')
    return
  }
  if (values.doctor && values.upgrade)
    throw new Error('Choose either --doctor or --upgrade.')
  if (values.doctor) {
    await diagnose()
    return
  }
  await deploy(values.upgrade ?? false)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.')
  process.exitCode = 1
})
