#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2).slice(2) // npx --no-install wrangler
fs.appendFileSync(
  'calls',
  JSON.stringify({ args, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + '\n',
)
const command = args.slice(0, 3).join(' ')
if (process.env.FAKE_FAIL && command.startsWith(process.env.FAKE_FAIL)) {
  console.error('simulated command failure')
  process.exit(42)
}
const state = fs.existsSync('.deployment.json')
  ? JSON.parse(fs.readFileSync('.deployment.json', 'utf8'))
  : undefined
if (command === 'd1 list --json') {
  console.log(
    process.env.FAKE_BAD_DATABASES
      ? '{"invalid":true}'
      : JSON.stringify(
          fs.existsSync('database-created')
            ? [{ name: state.name, uuid: 'database-id' }]
            : [],
        ),
  )
}
if (command.startsWith('d1 create')) fs.writeFileSync('database-created', 'yes')
if (command.startsWith('r2 bucket create') && process.env.FAKE_BUCKET_EXISTS)
  process.exit(42)
if (command.startsWith('r2 bucket info')) {
  if (!process.env.FAKE_BUCKET_EXISTS) process.exit(42)
  console.log(JSON.stringify({ name: state.name }))
}
if (command.startsWith('secret put')) {
  const secret = fs.readFileSync(0, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(secret)) process.exit(43)
}
