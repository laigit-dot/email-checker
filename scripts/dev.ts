import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createServer } from "vite";

const envFile = resolve(".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronExecutable = resolve(
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

function runBuild(script: "build:main" | "build:preload"): void {
  const result = spawnSync(npmCommand, ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runBuild("build:main");
runBuild("build:preload");

if (!existsSync(electronExecutable)) {
  throw new Error("Electron executable was not found. Run npm install first.");
}

const server = await createServer();
await server.listen();

const rendererUrl = server.resolvedUrls?.local[0];
if (!rendererUrl) {
  await server.close();
  throw new Error("Vite did not expose a local development URL.");
}

let electronProcess: ChildProcess | undefined = spawn(electronExecutable, ["."], {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: rendererUrl,
  },
  stdio: "inherit",
});

const shutdown = async (): Promise<void> => {
  electronProcess?.kill();
  electronProcess = undefined;
  await server.close();
};

electronProcess.once("exit", async (code) => {
  await shutdown();
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}
