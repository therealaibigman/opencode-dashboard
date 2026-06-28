const fs = require("node:fs");
const path = require("node:path");

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
        return [key, value];
      })
  );
}

const repoDir = __dirname;
const webDir = path.join(repoDir, "apps/web");
const nextBin = path.join(repoDir, "node_modules/next/dist/bin/next");
const env = {
  ...readEnvFile(path.join(repoDir, ".env")),
  NODE_ENV: "production",
};

module.exports = {
  apps: [
    {
      name: "opencode-dashboard",
      cwd: webDir,
      script: nextBin,
      args: "start -p 3002",
      env: {
        ...env,
        PORT: "3002",
      },
    },
    {
      name: "opencode-dashboard-scheduler",
      cwd: repoDir,
      script: "npm",
      args: "-w @ocdash/worker run start",
      env: {
        ...env,
        OC_DASH_MODE: "scheduler",
      },
    },
    ...["worker-1", "worker-2", "worker-3"].map((workerId) => ({
      name: `opencode-dashboard-${workerId}`,
      cwd: repoDir,
      script: "npm",
      args: "-w @ocdash/worker run start",
      env: {
        ...env,
        OC_DASH_MODE: "worker",
        OC_DASH_WORKER_ID: workerId,
      },
    })),
  ],
};
