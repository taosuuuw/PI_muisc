#!/usr/bin/env node
/**
 * 开发启动器：一条命令同时拉起 Vite（渲染进程）与 Electron（主进程）。
 *
 * 为什么不用 concurrently / npm-run-all：
 * 1. 零额外依赖——少一个依赖就少一处「在不同 Node / 系统上装不上」的风险。
 * 2. 需要「等 Vite 真的能访问了再启动 Electron」，否则主进程会加载到空白页，
 *    开发者会以为是自己代码写错了。
 *
 * 注意：所有子进程都用 `stdio: 'inherit'`。在受限沙箱/CI 里，管道 stdio
 * （child_process 默认的 'pipe'）会被拒绝并报 EPERM，而且管道还会让日志延迟输出。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const DEV_URL = process.env.PI_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';
const READY_TIMEOUT_MS = 90_000;
const isWindows = process.platform === 'win32';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function run(command, extraEnv = {}) {
  const child = spawn(command, {
    stdio: 'inherit',
    // shell: true 是为了让 pnpm.cmd / pnpm 这种平台差异交给系统自己解析。
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    // shell: true 让 child.pid 指向 cmd.exe，必须按进程树杀，否则 Electron 会残留。
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) kill(child);
  // 给子进程一点时间优雅退出，然后自己退出。
  setTimeout(() => process.exit(code), 300).unref();
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[pi] 启动渲染进程开发服务器…');
run('pnpm -F @pi/renderer dev');

if (DEV_URL.includes('127.0.0.1:5173') && !(await waitForServer(DEV_URL, READY_TIMEOUT_MS))) {
  console.error(`[pi] 渲染进程开发服务器未在 ${READY_TIMEOUT_MS / 1000} 秒内就绪，已退出。`);
  shutdown(1);
} else {
  console.log(`[pi] 开发服务器就绪：${DEV_URL}`);
  console.log('[pi] 启动 Electron…');
  const desktop = run('pnpm -F @pi/desktop dev', {
    PI_DEV_SERVER_URL: DEV_URL,
    PI_DEV: '1',
  });
  desktop.on('exit', (code) => {
    console.log(`[pi] Electron 已退出（code=${code ?? 0}），正在关闭开发服务器…`);
    shutdown(code ?? 0);
  });
}
