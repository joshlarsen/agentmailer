import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
const statePath = ".deployment.json",
  configPath = "wrangler.deploy.json";
const args = new Set(process.argv.slice(2));
const run = (args, { capture = false, input } = {}) => {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], {
    encoding: "utf8",
    stdio: capture
      ? ["pipe", "pipe", "pipe"]
      : input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
    input,
  });
  if (r.status !== 0)
    throw new Error(
      capture ? r.stderr : "Wrangler failed; rerun setup to resume.",
    );
  return r.stdout;
};
const save = (s) =>
  writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});
try {
  if (args.has("--doctor")) {
    if (!existsSync(configPath)) throw new Error("Run npm run setup first.");
    run(["whoami"]);
    run([
      "d1",
      "execute",
      JSON.parse(readFileSync(configPath, "utf8")).d1_databases[0]
        .database_name,
      "--remote",
      "--config",
      configPath,
      "--command",
      "SELECT count(*) AS messages FROM messages",
    ]);
    console.log(
      "Verify /health, routing catch-all, R2 activation, and sending-domain status in the dashboard.",
    );
  } else {
    let s = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : {};
    if (!s.account) {
      run(["login"]);
      run(["whoami"]);
      s.account = (await prompt.question("Cloudflare account ID: ")).trim();
      if (!/^[a-f0-9]{32}$/.test(s.account))
        throw new Error("Invalid account ID");
      s.domain = (await prompt.question("Dedicated mail domain/subdomain: "))
        .trim()
        .toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(s.domain))
        throw new Error("Invalid domain");
      s.sending =
        (
          await prompt.question("Enable sending? Requires Workers Paid (y/N): ")
        ).toLowerCase() === "y";
      s.retention =
        (await prompt.question("Retention days (0 = forever): ")) || "0";
      if (!/^\d+$/.test(s.retention)) throw new Error("Invalid retention");
      s.name = "agentmailer-" + randomBytes(4).toString("hex");
      save(s);
    }
    process.env.CLOUDFLARE_ACCOUNT_ID = s.account;
    if (!s.db) {
      let databases = JSON.parse(
        run(["d1", "list", "--json"], { capture: true }),
      );
      let db = databases.find((d) => d.name === s.name);
      if (!db) {
        run(["d1", "create", s.name, "--update-config=false"]);
        databases = JSON.parse(
          run(["d1", "list", "--json"], { capture: true }),
        );
        db = databases.find((d) => d.name === s.name);
      }
      s.db = db?.uuid;
      if (!s.db)
        throw new Error("Could not resolve database ID; inspect d1 list.");
      save(s);
    }
    if (!s.bucket) {
      try {
        run(["r2", "bucket", "create", s.name]);
      } catch {
        console.log(
          `If bucket ${s.name} already exists in your account, setup may reuse it.`,
        );
        if (
          (
            await prompt.question(
              "Bucket exists and is owned by this deployment? (y/N): ",
            )
          ).toLowerCase() !== "y"
        )
          throw new Error("Activate R2 in dashboard and rerun setup.");
      }
      s.bucket = true;
      save(s);
    }
    const config = {
      name: s.name,
      account_id: s.account,
      main: "src/index.ts",
      compatibility_date: "2026-11-13",
      vars: {
        MAIL_DOMAIN: s.domain,
        RETENTION_DAYS: s.retention,
        MAILBOX_LIMIT: "10",
        DAILY_LIMIT: "100",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: s.name,
          database_id: s.db,
          migrations_dir: "migrations",
        },
      ],
      r2_buckets: [{ binding: "MAIL", bucket_name: s.name }],
      triggers: { crons: ["*/15 * * * *"] },
      ...(s.sending ? { send_email: [{ name: "EMAIL" }] } : {}),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    run([
      "d1",
      "migrations",
      "apply",
      s.name,
      "--remote",
      "--config",
      configPath,
    ]);
    if (!s.secret) {
      const secret = randomBytes(32).toString("hex");
      console.log(
        "Save this OWNER_TOKEN in your password manager (shown once):",
        secret,
      );
      run(["secret", "put", "OWNER_TOKEN", "--config", configPath], {
        input: secret,
      });
      s.secret = true;
      save(s);
    }
    run(["deploy", "--config", configPath]);
    console.log(
      `In Cloudflare Email Service, enable routing for ${s.domain} and route catch-all to Worker ${s.name}. Do not replace existing MX records without reviewing conflicts.`,
    );
    if (s.sending)
      console.log("Onboard the same domain in Email Sending and verify DNS.");
    console.log(
      "Check the printed Worker URL /health; then follow README.md to create an agent and mailbox.",
    );
  }
} finally {
  prompt.close();
}
