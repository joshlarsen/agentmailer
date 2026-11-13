import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
test("setup resumes resources and secret; upgrade and doctor reuse deployment", () => {
  const root = mkdtempSync(join(tmpdir(), "agentmailer-setup-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, ".deployment.json"),
      JSON.stringify({
        account: "a".repeat(32),
        domain: "agents.example.com",
        name: "test-mail",
        retention: "30",
        sending: true,
      }),
    );
    writeFileSync(
      join(root, "bin/npx"),
      `#!/usr/bin/env node
 const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync('calls',JSON.stringify(args)+'\\n');
 if(args.includes('list'))console.log(JSON.stringify(fs.existsSync('created')?[{name:'test-mail',uuid:'database-id'}]:[]));
 if(args.includes('create')&&args.includes('d1'))fs.writeFileSync('created','yes');
 if(args.includes('secret'))process.stdin.resume();
 `,
      { mode: 0o755 },
    );
    const script = resolve("scripts/setup.mjs");
    const invoke = (args = []) => {
      const r = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env: {
          ...process.env,
          PATH: join(root, "bin") + ":" + process.env.PATH,
        },
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(r.status, 0, r.stderr);
      return r;
    };
    invoke();
    invoke(["--upgrade"]);
    invoke(["--doctor"]);
    const calls = readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      calls.filter((a) => a.includes("create") && a.includes("d1")).length,
      1,
    );
    assert.equal(
      calls.filter((a) => a.includes("create") && a.includes("bucket")).length,
      1,
    );
    assert.equal(calls.filter((a) => a.includes("secret")).length, 1);
    const config = JSON.parse(
      readFileSync(join(root, "wrangler.deploy.json"), "utf8"),
    );
    assert.equal(config.d1_databases[0].database_id, "database-id");
    assert.equal(config.vars.RETENTION_DAYS, "30");
    assert.equal(config.send_email[0].name, "EMAIL");
    assert(calls.some((a) => a.includes("execute") && a.includes("test-mail")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
