import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { get as httpsGet } from "node:https";
import { join } from "node:path";

const meshctrl = process.env.MESHCTRL_PATH ?? "/opt/meshcentral/meshcentral/meshctrl.js";
const labDir = "/mesh-lab";
const server = process.env.MESHCENTRAL_INTERNAL_URL ?? "wss://meshcentral.local:443";
const adminUser = process.env.MESHCENTRAL_ADMIN_USER ?? "aitadmin";
const adminPassword = process.env.MESHCENTRAL_ADMIN_PASSWORD ?? "change-me-meshcentral";
const groupName = "AIT Docker Lab";
const connectionFile = join(labDir, "connection.env");
if (existsSync(connectionFile)) unlinkSync(connectionFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync("node", [meshctrl, ...args], {
    cwd: labDir,
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!allowFailure && result.status !== 0) {
    throw new Error(`meshctrl ${args[0]} failed (${result.status}): ${output}`);
  }
  return { status: result.status, output };
}

function adminArgs(action, ...args) {
  return [action, "--url", server, "--loginuser", adminUser, "--loginpass", adminPassword, ...args];
}

function tokenArgs(credentials, action, ...args) {
  return [
    action,
    "--url",
    server,
    "--loginuser",
    credentials.tokenUser,
    "--loginpass",
    credentials.tokenPass,
    ...args,
  ];
}

function parseJson(output) {
  const starts = [output.indexOf("["), output.indexOf("{")].filter((index) => index >= 0);
  if (starts.length === 0) throw new Error(`MeshCentral returned no JSON: ${output}`);
  return JSON.parse(output.slice(Math.min(...starts)));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run(adminArgs("ServerInfo", "--json"), { allowFailure: true });
    if (result.status === 0 && result.output.includes('"port"')) return;
    await sleep(1_000);
  }
  throw new Error("MeshCentral did not accept the lab administrator credentials in time.");
}

function listGroups() {
  const parsed = parseJson(run(adminArgs("ListDeviceGroups", "--json")).output);
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

function ensureGroup() {
  let group = listGroups().find((candidate) => candidate.name === groupName);
  if (!group) {
    run(adminArgs("AddDeviceGroup", "--name", groupName, "--desc", "Disposable endpoint for the AIT Docker demonstration"));
    group = listGroups().find((candidate) => candidate.name === groupName);
  }
  if (!group?._id) throw new Error("MeshCentral created no usable AIT Docker Lab group.");
  return group._id;
}

function usableToken(credentials) {
  if (!credentials?.tokenUser || !credentials?.tokenPass) return false;
  return run(tokenArgs(credentials, "ListDevices", "--json"), { allowFailure: true }).status === 0;
}

function ensureOperator() {
  const path = join(labDir, "operator.json");
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (usableToken(saved)) return saved;
  }

  run(adminArgs("LoginTokens", "--remove", "ait-lab"), { allowFailure: true });
  const created = run(adminArgs("LoginTokens", "--add", "ait-lab", "--expire", "0")).output;
  const tokenUser = created.match(/^Username:\s*(.+)$/m)?.[1]?.trim();
  const tokenPass = created.match(/^Password:\s*(.+)$/m)?.[1]?.trim();
  if (!tokenUser || !tokenPass) {
    throw new Error("MeshCentral did not return credentials for the AIT login token.");
  }
  const credentials = { tokenUser, tokenPass };
  writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
  return credentials;
}

function downloadAgent(meshId) {
  for (const name of readdirSync(labDir)) {
    if (/^meshagent(?:64)?$/i.test(name)) unlinkSync(join(labDir, name));
  }
  // MeshCtrl currently returns exit code 1 after a successful download, so the
  // output file—not the status—is the source of truth here.
  // MeshCentral agent type 6 is Linux x86-64 and type 32 is Linux ARM64.
  // Selecting it at runtime keeps this lab usable on both Intel/AMD hosts and
  // Apple Silicon Docker Desktop without requiring Rosetta in the container.
  const agentType = process.arch === "arm64" ? "32" : "6";
  run(adminArgs("AgentDownload", "--id", meshId.split("/").at(-1), "--type", agentType), {
    allowFailure: true,
  });
  const name = readdirSync(labDir).find((candidate) => /^meshagent(?:64)?$/i.test(candidate));
  if (!name) throw new Error(`MeshCentral did not download Linux agent type ${agentType}.`);
  const path = join(labDir, name);
  chmodSync(path, 0o755);
  return path;
}

async function downloadSettings(meshId, agentPath) {
  const groupId = meshId.split("/").at(-1);
  const baseUrl = server.replace(/^wss:/, "https:").replace(/\/control\.ashx$/, "");
  const url = `${baseUrl}/meshsettings?id=${encodeURIComponent(groupId)}`;
  const settings = await new Promise((resolve, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`MeshCentral settings download failed (${response.statusCode}).`));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
  });
  writeFileSync(`${agentPath}.msh`, settings, { mode: 0o600 });
}

async function waitForDevice(meshId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const parsed = parseJson(run(adminArgs("ListDevices", "--json")).output);
    const devices = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const device = devices.find(
      (candidate) => candidate.meshid === meshId || candidate.name === "ait-mesh-lab",
    );
    if (device?._id) return device;
    await sleep(1_000);
  }
  throw new Error("The MeshCentral lab agent did not enroll in time.");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

await waitForServer();
const meshId = ensureGroup();
const operator = ensureOperator();
const agentPath = downloadAgent(meshId);
await downloadSettings(meshId, agentPath);
const agent = spawn(agentPath, [], { cwd: labDir, stdio: "inherit" });
agent.once("exit", (code) => {
  if (!existsSync(join(labDir, "connection.env"))) {
    console.error(`MeshCentral lab agent exited before enrollment (${code ?? "signal"}).`);
    process.exit(code ?? 1);
  }
});

const device = await waitForDevice(meshId);
const connection = [
  `MESHCENTRAL_URL=${shellQuote("https://meshcentral.local:443")}`,
  `MESHCENTRAL_USER=${shellQuote(operator.tokenUser)}`,
  `MESHCENTRAL_PASSWORD=${shellQuote(operator.tokenPass)}`,
  `MESHCENTRAL_MESH_ID=${shellQuote(meshId)}`,
  `MESHCENTRAL_DEVICE_ID=${shellQuote(device._id)}`,
  `MESHCENTRAL_DEVICE_NAME=${shellQuote("AIT-MESH-LAB")}`,
  `MESHCENTRAL_DEVICE_PLATFORM=${shellQuote("linux")}`,
  "",
].join("\n");
writeFileSync(connectionFile, connection, { mode: 0o600 });
console.log(`AIT MeshCentral lab endpoint is enrolled as ${device._id}.`);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => agent.kill(signal));
}
await new Promise((resolve) => agent.once("exit", resolve));
