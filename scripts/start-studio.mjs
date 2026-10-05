#!/usr/bin/env node
/**
 * One-click InkOS Studio launcher.
 * Always starts against the local writing project (my-novel), not the monorepo root.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.INKOS_STUDIO_PORT || 4567);
const URL = `http://localhost:${PORT}`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIR = resolve(REPO_ROOT, process.env.INKOS_PROJECT_DIR || "my-novel");
const CLI = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isPortListening(port) {
  return new Promise((resolveListening) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveListening(false);
    });
    socket.once("error", () => {
      resolveListening(false);
    });
  });
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function killListenerOnPort(port) {
  if (process.platform !== "win32") {
    return;
  }
  await new Promise((resolveKill) => {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;` +
          `if ($conns) { $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`,
      ],
      { stdio: "ignore" },
    );
    ps.on("exit", () => resolveKill());
    ps.on("error", () => resolveKill());
  });
}

async function main() {
  if (!(await pathExists(CLI))) {
    console.error(`[InkOS] CLI 未构建：找不到 ${CLI}`);
    console.error("请先在仓库根目录执行: pnpm build");
    process.exit(1);
  }

  if (!(await pathExists(join(PROJECT_DIR, "inkos.json")))) {
    console.error(`[InkOS] 找不到写作项目：${PROJECT_DIR}`);
    console.error("请确认 my-novel/inkos.json 存在，或设置 INKOS_PROJECT_DIR。");
    process.exit(1);
  }

  if (await isPortListening(PORT)) {
    console.log(`[InkOS] 端口 ${PORT} 已被占用，先结束旧进程再从 my-novel 启动…`);
    await killListenerOnPort(PORT);
    // Give the OS a moment to release the port
    await new Promise((r) => setTimeout(r, 800));
    if (await isPortListening(PORT)) {
      console.log(`[InkOS] 端口仍被占用，直接打开已有 Studio：${URL}`);
      openBrowser(URL);
      return;
    }
  }

  console.log(`[InkOS] 正在启动 Studio`);
  console.log(`        项目：${PROJECT_DIR}`);
  console.log(`        地址：${URL}`);

  const child = spawn(process.execPath, [CLI, "studio", "-p", String(PORT)], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    env: { ...process.env },
  });

  child.on("error", (err) => {
    console.error(`[InkOS] 启动失败：${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`[InkOS] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
