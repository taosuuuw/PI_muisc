/**
 * 自定义源（LX Music 协议）沙箱子进程。
 *
 * 这个文件是**纯 JS**、且刻意放在 `runtime/` 下：它由 Electron 以 `ELECTRON_RUN_AS_NODE`
 * 直接执行，**不经过 esbuild 打包**（打包器会把 `node:vm` 的用法搞坏，也会把用户脚本
 * 与我们的模块作用域混在一起）。
 *
 * ## 隔离模型（说清楚，别假装它是 perfect sandbox）
 *
 * 1. **独立进程**：插件崩了、死循环了、内存爆了，最多杀掉这个子进程，UI 与主进程不受影响；
 *    主进程的 cookie、IPC、文件句柄它一律碰不到。**cookie 永远不会进入这个进程。**
 * 2. **独立 Realm**：用户脚本跑在 `vm.createContext` 造出来的新全局环境里。宿主函数
 *    （Buffer/crypto/zlib）只通过一个 bootstrap 阶段就被 `delete` 掉的桥接函数进入上下文，
 *    脚本能拿到的 `lx.*`、`setTimeout`、`fetch` 都是**上下文 Realm 自己造的函数**，
 *    所以 `fn.constructor('return process')()` 这种经典逃逸在脚本里拿不到宿主 Realm。
 * 3. **抹掉宿主全局**：bootstrap 之后 `delete globalThis.process / Buffer / require / global`。
 *    即使脚本从宿主函数对象里掏出宿主 Realm 的 `Function`，函数体里也找不到 `process`。
 * 4. **网络全部经主进程代理**：脚本的 `lx.request` / `fetch` 只是往 stdout 写一行 JSON，
 *    由主进程发请求（可审计、可限流、可加超时），子进程自己没有网络能力（它当然还能
 *    `import('node:http')`，但那是「故意作恶」级别的事，见下）。
 *
 * 剩下的风险要如实说：**这不是一个能挡住蓄意作恶脚本的硬沙箱**。Node 没有可靠的
 * 「同进程不可逃逸」机制（`vm` 从来不是安全边界），一个铁了心要逃的脚本仍可能拿到
 * 当前用户权限下的文件读写。这和 LX Music 自身的模型一致（它把脚本放进隐藏渲染进程，
 * 靠 `nodeIntegration:false` 挡住大部分，但同样不承诺防恶意脚本）。我们能承诺的是：
 * **它拿不到你的网易云 cookie、拿不到应用内存、搞崩不了界面**，而且随时可以被禁用。
 *
 * ## 与主进程的协议（stdio 上的 JSON Lines）
 *
 * 子 → 父：`{kind:'ready'}` / `{kind:'log',level,message}` /
 *          `{kind:'http',reqId,url,options}` / `{kind:'reply',id,ok,result|error}`
 * 父 → 子：`{kind:'http-result',reqId,ok,response|error}` /
 *          `{kind:'load',id,script,info}` / `{kind:'invoke',id,source,type,info}` /
 *          `{kind:'dispose',id}` / `{kind:'exit'}`
 */

import { createHash, createCipheriv, randomBytes, createPublicKey, publicEncrypt, constants as cryptoConstants } from 'node:crypto';
import { promisify } from 'node:util';
import vm from 'node:vm';
import zlib from 'node:zlib';

/* 先把要用的宿主能力抓在手里——后面会把全局的它们删掉（见隔离模型第 3 条）。 */
const hostProcess = process;
const hostBuffer = Buffer;
const hostSetTimeout = setTimeout;
const hostSetInterval = setInterval;
const hostClearTimeout = clearTimeout;
const writeLine = (text) => hostProcess.stdout.write(`${text}\n`);

const inflateAsync = promisify(zlib.inflate);
const deflateAsync = promisify(zlib.deflate);

let context;
let handler;
let inited = false;
let pendingInit;
const timers = new Map();
let timerSeq = 0;
const pendingHttp = new Map();
let httpSeq = 0;

function send(message) {
  writeLine(JSON.stringify(message));
}

function log(level, message) {
  send({ kind: 'log', level, message: String(message) });
}

/* ------------------------------------------------------------------ *
 * 桥接：上下文 Realm 里的函数最终都走到这里
 * ------------------------------------------------------------------ */

function encodeBody(value) {
  if (hostBuffer.isBuffer(value)) return { __piBuffer: value.toString('base64') };
  if (value === undefined) return undefined;
  return value;
}

function httpRequest(url, options) {
  const reqId = ++httpSeq;
  const options2 = {
    method: options?.method,
    headers: options?.headers,
    body: encodeBody(options?.body),
    form: options?.form,
    formData: options?.formData,
    timeout: options?.timeout,
  };
  return new Promise((resolve, reject) => {
    pendingHttp.set(reqId, { resolve, reject });
    send({ kind: 'http', reqId, url: String(url), options: options2 });
  });
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    hostClearTimeout(timer);
    timers.delete(id);
  }
}

function startTimer(fn, ms, repeat) {
  const id = ++timerSeq;
  const delay = Number.isFinite(Number(ms)) && Number(ms) >= 0 ? Number(ms) : 0;
  const wrapped = () => {
    if (!repeat) timers.delete(id);
    try {
      fn();
    } catch (error) {
      log('error', `[lx] 定时器回调抛错：${describe(error)}`);
    }
  };
  const timer = repeat ? hostSetInterval(wrapped, delay) : hostSetTimeout(wrapped, delay);
  timers.set(id, timer);
  return id;
}

/** {@link bridge} 的操作表。全部是同步旋钮，异步结果通过 Promise 回到上下文。 */
const operations = {
  log(level, message) {
    log(level ?? 'info', message);
  },
  http(url, options) {
    return httpRequest(url, options ?? {});
  },
  on(name, fn) {
    if (name !== 'request') {
      return Promise.reject(new Error(`The event is not supported: ${String(name)}`));
    }
    if (typeof fn !== 'function') {
      return Promise.reject(new Error('request 事件必须注册一个函数'));
    }
    handler = fn;
    return Promise.resolve();
  },
  send(name, data) {
    if (name === 'inited') {
      if (inited) return Promise.reject(new Error('Script is inited'));
      inited = true;
      pendingInit?.resolve(data);
      return Promise.resolve();
    }
    if (name === 'updateAlert') {
      log('info', `[lx] 脚本请求更新提示：${JSON.stringify(data)}`);
      return Promise.resolve();
    }
    return Promise.reject(new Error(`The event is not supported: ${String(name)}`));
  },
  'utils.buffer.from'() {
    return (...args) => hostBuffer.from(...args);
  },
  'utils.buffer.bufToString'() {
    return (buf, format) => hostBuffer.from(buf, 'binary').toString(format);
  },
  'utils.crypto.md5'() {
    return (value) => createHash('md5').update(value).digest('hex');
  },
  'utils.crypto.randomBytes'() {
    return (size) => randomBytes(Number(size) || 0);
  },
  'utils.crypto.aesEncrypt'() {
    return (buffer, mode, key, iv) => {
      const cipher = createCipheriv(mode, key, iv);
      return hostBuffer.concat([cipher.update(buffer), cipher.final()]);
    };
  },
  'utils.crypto.rsaEncrypt'() {
    return (buffer, key) => {
      const padded = hostBuffer.concat([hostBuffer.alloc(128 - buffer.length), buffer]);
      const publicKey = createPublicKey({
        key: hostBuffer.from(key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return publicEncrypt({ key: publicKey, padding: cryptoConstants.RSA_NO_PADDING }, padded);
    };
  },
  'utils.zlib.inflate'() {
    return (buffer) => inflateAsync(buffer);
  },
  'utils.zlib.deflate'() {
    return (data) => deflateAsync(data);
  },
  'timers.set'(_kind, fn, ms) {
    return startTimer(fn, ms, false);
  },
  'timers.setInterval'(_kind, fn, ms) {
    return startTimer(fn, ms, true);
  },
  'timers.clear'(id) {
    clearTimer(id);
  },
};

/** 唯一进入上下文的宿主函数，bootstrap 跑完就被 `delete`。 */
function bridge(op, ...args) {
  const fn = operations[op];
  if (!fn) return Promise.reject(new Error(`未知的桥接操作：${String(op)}`));
  try {
    return fn(...args);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(describe(error)));
  }
}

/* ------------------------------------------------------------------ *
 * 上下文 bootstrap：在**上下文 Realm 里**造出 lx / 定时器 / fetch
 * ------------------------------------------------------------------ */

const BOOTSTRAP = [
  'const B = __piBridge;',
  'delete globalThis.__piBridge;',
  'const info = __piScriptInfo;',
  'delete globalThis.__piScriptInfo;',
  '',
  'function makeRequest(url, options, cb) {',
  '  options = options || {};',
  '  let cancelled = false;',
  '  const promise = B("http", String(url), {',
  '    method: options.method, headers: options.headers, body: options.body,',
  '    form: options.form, formData: options.formData, timeout: options.timeout',
  '  });',
  '  promise.then(function (response) {',
  '    if (cancelled) return;',
  '    if (typeof cb === "function") cb(null, response, response.body);',
  '  }, function (error) {',
  '    if (cancelled) return;',
  '    const wrapped = new Error(error && error.message ? error.message : String(error));',
  '    if (typeof cb === "function") cb(wrapped); else B("log", "error", "[lx.request] " + wrapped.message);',
  '  });',
  '  return function cancel() { cancelled = true; };',
  '}',
  '',
  'function makeLogger(level) {',
  '  return function () {',
  '    const parts = [];',
  '    for (let i = 0; i < arguments.length; i += 1) {',
  '      const item = arguments[i];',
  '      parts.push(typeof item === "string" ? item : safeStringify(item));',
  '    }',
  '    B("log", level, parts.join(" "));',
  '  };',
  '}',
  '',
  'function safeStringify(value) {',
  '  try { return JSON.stringify(value); } catch (error) { return String(value); }',
  '}',
  '',
  'const lx = {',
  '  version: "2.0.0",',
  '  env: "desktop",',
  '  currentScriptInfo: {',
  '    name: info.name, description: info.description, version: info.version,',
  '    author: info.author, homepage: info.homepage, rawScript: info.rawScript',
  '  },',
  '  EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },',
  '  on: function (name, fn) { return B("on", String(name), fn); },',
  '  send: function (name, data) { return B("send", String(name), data); },',
  '  request: makeRequest,',
  '  utils: {',
  '    buffer: { from: B("utils.buffer.from"), bufToString: B("utils.buffer.bufToString") },',
  '    crypto: {',
  '      md5: B("utils.crypto.md5"),',
  '      randomBytes: B("utils.crypto.randomBytes"),',
  '      aesEncrypt: B("utils.crypto.aesEncrypt"),',
  '      rsaEncrypt: B("utils.crypto.rsaEncrypt")',
  '    },',
  '    zlib: { inflate: B("utils.zlib.inflate"), deflate: B("utils.zlib.deflate") }',
  '  }',
  '};',
  'globalThis.lx = lx;',
  '',
  'globalThis.console = {',
  '  log: makeLogger("info"), info: makeLogger("info"), warn: makeLogger("warn"),',
  '  error: makeLogger("error"), debug: makeLogger("debug"), trace: makeLogger("debug")',
  '};',
  '',
  'globalThis.setTimeout = function (fn, ms) { return B("timers.set", "setTimeout", fn, ms); };',
  'globalThis.setInterval = function (fn, ms) { return B("timers.setInterval", "setInterval", fn, ms); };',
  'globalThis.clearTimeout = function (id) { return B("timers.clear", id); };',
  'globalThis.clearInterval = function (id) { return B("timers.clear", id); };',
  '',
  'globalThis.fetch = function (url, init) {',
  '  init = init || {};',
  '  return B("http", String(url), { method: init.method, headers: init.headers, body: init.body })',
  '    .then(function (response) {',
  '      return {',
  '        ok: response.statusCode >= 200 && response.statusCode < 300,',
  '        status: response.statusCode,',
  '        statusText: response.statusMessage || "",',
  '        headers: { get: function (key) { return response.headers[String(key).toLowerCase()]; } },',
  '        text: function () { return Promise.resolve(response.body); },',
  '        json: function () { return Promise.resolve(JSON.parse(response.body)); },',
  '        arrayBuffer: function () { return Promise.resolve(response.raw); }',
  '      };',
  '    });',
  '};',
].join('\n');

/** bootstrap 之后把宿主全局抹掉（隔离模型第 3 条）。做不到就算了，不影响功能。 */
function scrubHostGlobals() {
  for (const name of ['process', 'Buffer', 'require', 'global', 'module']) {
    try {
      delete globalThis[name];
    } catch {
      /* 不可配置就跳过 */
    }
  }
  if (globalThis.process !== undefined) log('warn', '[lx] 未能抹掉宿主 process 全局');
}

/* ------------------------------------------------------------------ *
 * 命令处理
 * ------------------------------------------------------------------ */

function describe(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === undefined) return '未知错误（undefined）';
  return String(error);
}

function handleLoad(message) {
  disposeContext();
  context = vm.createContext({
    __piBridge: bridge,
    __piScriptInfo: message.info,
  });
  vm.runInContext(BOOTSTRAP, context, { filename: 'lx-bootstrap.js' });
  scrubHostGlobals();

  let initTimer;
  const initPromise = new Promise((resolve, reject) => {
    pendingInit = { resolve, reject };
    initTimer = hostSetTimeout(
      () => reject(new Error('脚本初始化超时：没有在限定时间内发送 inited 事件')),
      15_000,
    );
  });

  try {
    vm.runInContext(message.script, context, {
      filename: `${message.info?.name ?? 'lx-script'}.js`,
      // 只约束顶层同步执行；异步逻辑由上一个 initTimer 兜底。
      timeout: 10_000,
    });
  } catch (error) {
    hostClearTimeout(initTimer);
    pendingInit = undefined;
    throw new Error(`脚本执行出错：${describe(error)}`);
  }

  return initPromise.then(
    (data) => {
      hostClearTimeout(initTimer);
      pendingInit = undefined;
      return { inited: true, payload: data };
    },
    (error) => {
      hostClearTimeout(initTimer);
      pendingInit = undefined;
      throw error instanceof Error ? error : new Error(describe(error));
    },
  );
}

function disposeContext() {
  for (const id of [...timers.keys()]) clearTimer(id);
  for (const [reqId, pending] of pendingHttp) {
    pending.reject(new Error('沙箱已重置'));
    pendingHttp.delete(reqId);
  }
  context = undefined;
  handler = undefined;
  inited = false;
  pendingInit = undefined;
}

async function handleInvoke(message) {
  if (!context) throw new Error('脚本还没有加载');
  if (!inited) throw new Error('脚本还没有完成初始化');
  if (!handler) throw new Error('脚本没有用 lx.on(lx.EVENT_NAMES.request, ...) 注册处理器');
  const payload = {
    source: message.source,
    action: message.action,
    info: { type: message.type, musicInfo: message.info },
  };
  // 处理器是**上下文 Realm 的函数**：跨 Realm 调用没问题，它返回的 thenable 也能被 await。
  return await handler(payload);
}

function handleMessage(message) {
  if (message.kind === 'http-result') {
    const pending = pendingHttp.get(message.reqId);
    if (!pending) return;
    pendingHttp.delete(message.reqId);
    if (message.ok) {
      const response = message.response ?? {};
      pending.resolve({
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
        headers: response.headers ?? {},
        bytes: response.bytes ?? 0,
        // 脚本世界里没有 Buffer 全局，但 lx.request 的回调必须能拿到二进制体
        // （解密流程要它），所以这里把 base64 还原成宿主 Buffer 再交出去。
        raw: hostBuffer.from(response.rawBase64 ?? '', 'base64'),
        body: response.hasJson ? response.json : (response.text ?? ''),
      });
    } else {
      pending.reject(new Error(message.error ?? '请求失败'));
    }
    return;
  }

  if (message.kind === 'exit') {
    disposeContext();
    hostProcess.exit(0);
  }

  const reply = (ok, value) => {
    if (message.id === undefined) return;
    send({ kind: 'reply', id: message.id, ok, ...(ok ? { result: value } : { error: describe(value) }) });
  };

  if (message.kind === 'load') {
    handleLoad(message).then(
      (result) => reply(true, result),
      (error) => reply(false, error),
    );
    return;
  }

  if (message.kind === 'invoke') {
    handleInvoke(message).then(
      (result) => reply(true, result),
      (error) => reply(false, error),
    );
    return;
  }

  if (message.kind === 'dispose') {
    disposeContext();
    reply(true, undefined);
  }
}

/* ------------------------------------------------------------------ *
 * stdio 主循环
 * ------------------------------------------------------------------ */

let buffer = '';
hostProcess.stdin.setEncoding('utf8');
hostProcess.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        log('error', `[lx] 无法处理主进程消息：${describe(error)}`);
      }
    }
    index = buffer.indexOf('\n');
  }
});

hostProcess.on('uncaughtException', (error) => {
  log('error', `[lx] 脚本未捕获异常：${describe(error)}`);
  // 初始化阶段的未捕获异常按 LX 的语义等同「初始化失败」。
  pendingInit?.reject(error instanceof Error ? error : new Error(describe(error)));
});

hostProcess.on('unhandledRejection', (reason) => {
  log('error', `[lx] 脚本未处理的 Promise 拒绝：${describe(reason)}`);
  pendingInit?.reject(reason instanceof Error ? reason : new Error(describe(reason)));
});

send({ kind: 'ready' });
