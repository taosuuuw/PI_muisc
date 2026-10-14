/**
 * QQ 音乐「逐字」歌词（QRC）的**拉取与解密**。
 *
 * 解析不在这里：`parsers.ts` 的 `parseQrc()` 早就能读 QRC 文本。缺的一直是**前面两步** ——
 * 走对接口、把密文解开。本文件补的正是这两步。
 *
 * ── 为什么以前是「不提供逐字」 ──
 * QQ 源原来只走 `c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`（公开通道），
 * 那条只给逐行 LRC。逐字在另一条接口 `music.musichallSong.PlayLyricInfo` 上：
 * 参数 `qrc` 打开时，响应里的 `lyric` 变成一段 **hex 密文**，解开才是逐字 QRC 文本
 * （`trans` / `roma` 同理，是两个独立字段；实测 `crypt: 0` 时 `trans` 反而是 base64 明文）。
 *
 * ── 加密方案：全部以**实测**为准 ──
 * 三段 DES 串成 3DES-EDE（解-加-解）：`D(K1) → E(K2) → D(K3)`，每段只用密钥**前 8 字节**，
 * ECB（每 8 字节独立成块），不足 8 字节补 0（不是 PKCS#7），最后 zlib 解压。
 *   K1 = `!@#)(NHLiuy*$%^&`、K2 = `123ZXC!@#)(*$%^&`、K3 = `!@#)(*$%^&abcDEF`
 *
 * ── 为什么这里的 DES 不能直接用 `node:crypto`，也不能用「标准 DES」 ──
 * 两件事都是**实测出来的**，不是猜的：
 *
 * ① `node:crypto` 走不通：Node 18 起用的 OpenSSL 3 把 DES/3DES 挪进了 legacy provider，
 *    `crypto.createDecipheriv('des-ede3', …)` 直接报
 *    `error:0308010C:digital envelope routines::unsupported`（本机实测，不是密钥长度写错）。
 * ② 标准 DES 也解不开：把 FIPS 46-3 的置换表原样搬来实现一版标准 DES，
 *    拿真密文跑出来是乱码（`incorrect header check`）。逐位比对后发现，
 *    **能解开 QQ 真实密文的那一版在三个地方与 FIPS 抄本不同**，而这三处必须一起照做：
 *      · 分组字节序：8 字节块按「低字/高字」两个 32 位小端字读入，位号 p ≤ 32 落在低字的
 *        第 `32-p` 位、p > 32 落在高字第 `64-p` 位（等价于每个 4 字节半区内倒序再交换半区）；
 *      · 子密钥：PC2 的后半段从「D 半区」取位时，比 FIPS 表多偏了一位；
 *      · S 盒：两格取值与常见 FIPS 4×16 抄本不同（`S2[1][7]` 取 15 而非 14、
 *        `S4[3][5]` 取 10 而非 1），这两个格子见下面的 `SBOX_PROTOCOL_OVERRIDES`。
 *    证据链（都留了测试）：本机参考实现（`smart-lyric` 1.0.4，ISC 许可）公布的三组
 *    key/plain/cipher 向量我们 3/3 复现；用它的 S 盒取值能解开真密文，换成 FIPS 生成的
 *    那份就解不开 —— 所以上表是「协议口径」，不是笔误。来源与授权见 `docs/CREDITS.md`。
 *
 * 一句话：这是**与真实密文可互通的 DES 变体**，不是教科书 DES。别顺手把它「修正」成标准版，
 * 那样 QQ 的逐字会整片变成乱码（`qq-qrc.test.ts` 里用真密文钉住了这一点）。
 */
import { inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ *
 * 块与密钥的位号约定：低字 / 高字两个 32 位字
 * ------------------------------------------------------------------ */

/**
 * 一个 64 位数据块拆成两个 32 位字（都按小端从字节读出来）。
 * 位号 1..64 采用「最高位优先」：p ≤ 32 → `low` 的第 `32-p` 位；p > 32 → `high` 的第 `64-p` 位。
 */
interface Block {
  low: number;
  high: number;
}

/** 导出给单测用（`desBlockInPlace` 的入参类型）。 */
export type { Block };

/** 位号 → 所在 32 位字里的掩码（bitmap(0) 是该字最高位，bitmap(31) 是最低位）。 */
const bitmap = (index: number): number =>
  index < 32 ? (1 << (31 - index)) >>> 0 : (1 << (63 - index)) >>> 0;

/* ------------------------------------------------------------------ *
 * FIPS 46-3 的标准表（S 盒那两格见 SBOX_PROTOCOL_OVERRIDES）
 * ------------------------------------------------------------------ */

/** 初始置换 IP。 */
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
/** 末置换 FP（IP 的逆）。 */
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
/** 扩展置换 E（32 → 48）。 */
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
  12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
  22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
/** P 盒置换（32 → 32）。 */
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
/** 密钥置换 PC1（64 → 56）。 */
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
/** 压缩置换 PC2（56 → 48）。 */
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
/** 16 轮里 C / D 两半各自左移的位数。 */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/**
 * 8 个 S 盒，每个 4 行 × 16 列（FIPS 46-3 原表，行优先）。
 *
 * 运行时按「输入值优先」的顺序摊平成 512 项（`flatSBox()`）——协议那一侧就是这么查的。
 */
const SBOX_ROWS: readonly (readonly number[])[] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/**
 * 协议在这两个格子上与 FIPS 抄本不同：`[盒号(0 基), 行, 列, 取值]`。
 *
 *   · `S2[1][7]`：FIPS 抄本是 14，协议口径是 15；
 *   · `S4[3][5]`：FIPS 抄本是 1，协议口径是 10。
 *
 * 为什么要在这里硬写：这两格是**解开真实密文所必需**的（实测：换成 FIPS 那份取值，
 * 同一段真密文立刻 `incorrect header check`）。删掉它们会让 QQ 逐字整体变成乱码，
 * `qq-qrc.test.ts` 用真密文钉住了这条。
 */
const SBOX_PROTOCOL_OVERRIDES: readonly (readonly [number, number, number, number])[] = [
  [1, 1, 7, 15],
  [3, 3, 5, 10],
];

/** 把 4×16 的 S 盒摊成「输入值优先」的 512 项（协议那一侧的查表顺序），并补上协议的两格。 */
function flatSBox(): Uint8Array {
  const flat = new Uint8Array(512);
  for (let box = 0; box < 8; box += 1) {
    const rows = SBOX_ROWS[box] ?? [];
    for (let six = 0; six < 64; six += 1) {
      const row = ((six & 0b100000) >> 4) | (six & 1);
      const column = (six >> 1) & 0b1111;
      flat[box * 64 + six] = rows[row * 16 + column] ?? 0;
    }
  }
  for (const [box, row, column, value] of SBOX_PROTOCOL_OVERRIDES) {
    /*
     * 反算这个格子对应的「输入值」——与上面 `row` / `column` 的算法互逆：
     * 行号的**高位**进输入值的第 5 位、列号进中间 4 位、行号的**低位**进第 0 位。
     * 这一处写反过（把行号低位当成第 5 位），结果改的是隔壁格子、真密文照样解不开 ——
     * 所以 `qq-qrc.test.ts` 里既钉了两格取值，也钉了整张 512 项的表。
     */
    const six = (((row >> 1) & 1) << 5) | (column << 1) | (row & 1);
    flat[box * 64 + six] = value;
  }
  return flat;
}

/**
 * 摊平后的 512 项 S 盒（输入值优先）。
 *
 * 导出给单测：整张表的 sha256 被钉在 `tests/lyrics-qrc.test.ts` 里 —— 这张表是
 * 「协议口径」，抄错一格就解不开真密文，而三组向量未必碰得到那一格（本机就踩过：
 * 把 override 的反算写错、改到了隔壁格子，向量照样 3/3，真密文却挂了）。
 */
export const SBOX_FLAT: Uint8Array = flatSBox();

/* ------------------------------------------------------------------ *
 * DES（互通变体）
 * ------------------------------------------------------------------ */

/** 从一个字里取出「位号 p」对应的那个位（p 是 1..64 的全局位号）。 */
function bitOf(source: Block, position: number): boolean {
  const word = position <= 32 ? source.low : source.high;
  return (word & bitmap(position - 1)) !== 0;
}

/** 把 16 个子密钥算出来（48 位各自拆在 `low` 的高 24 位与 `high` 的高 24 位里）。 */
function subKeysOf(key: Block): Block[] {
  let left = 0;
  let right = 0;
  for (let index = 0; index < 28; index += 1) {
    const first = PC1[index] ?? 0;
    if (bitOf(key, first)) left = (left | bitmap(index)) >>> 0;
    const second = PC1[index + 28] ?? 0;
    if (bitOf(key, second)) right = (right | bitmap(index)) >>> 0;
  }

  const keys: Block[] = [];
  for (const shift of SHIFTS) {
    const mask = [0, 0x8000_0000, 0xc000_0000][shift] ?? 0;
    const carryLeft = (left & mask) >>> (shift === 1 ? 27 : 26);
    const carryRight = (right & mask) >>> (shift === 1 ? 27 : 26);
    left = (((left << shift) | (carryLeft & 0xffff_fff0)) >>> 0);
    right = (((right << shift) | (carryRight & 0xffff_fff0)) >>> 0);

    const sub: Block = { low: 0, high: 0 };
    for (let index = 0; index < 48; index += 1) {
      const source = PC2[index] ?? 0;
      if (index >= 24) {
        /*
         * 后半段从 D 半区取位。注意这里是 `source - 28`，FIPS 表的口径本该是 `source - 29`：
         * 这一位的偏移是协议要求（见文件头 ②），改回去真密文就解不开。
         */
        const carry = (right & bitmap(source - 28)) !== 0;
        if (carry) sub.high = (sub.high | bitmap(index - 24)) >>> 0;
      } else if ((left & bitmap(source - 1)) !== 0) {
        sub.low = (sub.low | bitmap(index)) >>> 0;
      }
    }
    keys.push(sub);
  }
  return keys;
}

/** 轮函数 F：扩展 → 异或子密钥 → 8 个 S 盒 → P 置换；结果直接写回 `data`。 */
function round(data: Block, subKey: Block): void {
  let low = 0;
  let high = 0;
  const source = data.high;
  for (let index = 0; index < 48; index += 1) {
    const mask = bitmap((E[index] ?? 0) - 1);
    if ((mask & source) === 0) continue;
    if (index >= 24) high = (high | bitmap(index - 24)) >>> 0;
    else low = (low | bitmap(index)) >>> 0;
  }
  low = (low ^ subKey.low) >>> 0;
  high = (high ^ subKey.high) >>> 0;

  const groups = [
    (low >>> 26) & 0x3f, (low >>> 20) & 0x3f, (low >>> 14) & 0x3f, (low >>> 8) & 0x3f,
    (high >>> 26) & 0x3f, (high >>> 20) & 0x3f, (high >>> 14) & 0x3f, (high >>> 8) & 0x3f,
  ];
  let packed = 0;
  let group = 0;
  for (let offset = 0; offset < 448; offset += 64, group += 1) {
    packed = ((packed | (SBOX_FLAT[groups[group]! + offset] ?? 0)) * 16);
  }
  packed = (packed | (SBOX_FLAT[64 * group + groups[group]!] ?? 0)) >>> 0;

  let permuted = 0;
  for (let index = 0; index < 32; index += 1) {
    if ((packed & bitmap((P[index] ?? 0) - 1)) !== 0) permuted = (permuted | bitmap(index)) >>> 0;
  }
  data.high = (permuted ^ data.low) >>> 0;
  data.low = source;
}

/**
 * 单个 8 字节块：先 IP，再 16 轮（解密时子密钥倒序），换回左右两半，再 FP。
 *
 * 导出给单测用：`qq-qrc.test.ts` 拿参考实现公布的三组向量钉住这套变体。
 */
export function desBlockInPlace(data: Block, keys: readonly Block[], encrypt: boolean): void {
  const ordered = encrypt ? keys : [...keys].reverse();
  let low = 0;
  let high = 0;
  for (let index = 0; index < 64; index += 1) {
    if (!bitOf(data, IP[index] ?? 0)) continue;
    if (index >= 32) high = (high | bitmap(index)) >>> 0;
    else low = (low | bitmap(index)) >>> 0;
  }
  data.low = low;
  data.high = high;

  for (let index = 0; index < 16; index += 1) round(data, ordered[index] ?? { low: 0, high: 0 });

  const keep = data.low;
  data.low = data.high;
  data.high = keep;

  low = 0;
  high = 0;
  for (let index = 0; index < 64; index += 1) {
    if (!bitOf(data, FP[index] ?? 0)) continue;
    if (index >= 32) high = (high | bitmap(index)) >>> 0;
    else low = (low | bitmap(index)) >>> 0;
  }
  data.low = low;
  data.high = high;
}

/** 按 ECB 跑一段字节（长度必须是 8 的倍数）；`key` 只取前 8 字节。 */
export function desEcb(data: Buffer, key: Buffer, encrypt: boolean): Buffer {
  const keys = subKeysOf({ low: key.readUInt32LE(0), high: key.readUInt32LE(4) });
  const out = Buffer.from(data);
  for (let offset = 0; offset + 8 <= out.length; offset += 8) {
    const block: Block = { low: out.readUInt32LE(offset), high: out.readUInt32LE(offset + 4) };
    desBlockInPlace(block, keys, encrypt);
    out.writeUInt32LE(block.low, offset);
    out.writeUInt32LE(block.high, offset + 4);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * QRC：密钥、零填充、3DES-EDE、zlib
 * ------------------------------------------------------------------ */

/**
 * 三段密钥。只用前 8 字节（原文给的 16 字节，后 8 字节用不上）。
 * 顺序不能自作主张：解密是 `D(K1) → E(K2) → D(K3)`，单测里用真密文钉住。
 */
const QRC_KEYS: readonly Buffer[] = [
  Buffer.from('!@#)(NHLiuy*$%^&', 'utf8'),
  Buffer.from('123ZXC!@#)(*$%^&', 'utf8'),
  Buffer.from('!@#)(*$%^&abcDEF', 'utf8'),
];

/** 补齐到 8 的倍数：**补 0**（不是 PKCS#7）。 */
function padToBlock(data: Buffer): Buffer {
  const remainder = data.length % 8;
  if (remainder === 0) return data;
  const padded = Buffer.alloc(data.length + (8 - remainder));
  data.copy(padded);
  return padded;
}

/**
 * 解开一段 QRC 密文（已经是字节），成功返回 QRC 文本，失败返回 `undefined`。
 *
 * 失败不抛：歌词是增强功能，某个源换了密钥、返回了半截数据，都不该把播放搞挂 ——
 * 上层拿到 `undefined` 会自动退回逐行 LRC。
 */
export function decryptQrcBytes(cipher: Buffer): string | undefined {
  if (cipher.length === 0 || cipher.length % 8 !== 0) return undefined;
  try {
    const first = desEcb(cipher, QRC_KEYS[0] ?? Buffer.alloc(8), false);
    const second = desEcb(first, QRC_KEYS[1] ?? Buffer.alloc(8), true);
    const plain = desEcb(second, QRC_KEYS[2] ?? Buffer.alloc(8), false);
    const inflated = inflateSync(plain);
    /* 解出来的正文可能带 UTF-8 BOM，剥掉（否则第一行会多一个看不见的字符）。 */
    const start = inflated[0] === 0xef && inflated[1] === 0xbb && inflated[2] === 0xbf ? 3 : 0;
    return inflated.subarray(start).toString('utf8');
  } catch {
    return undefined;
  }
}

/** 解开一段 **hex 形式**的 QRC 密文（接口就是这么下发的）。 */
export function decryptQrcHex(hex: string): string | undefined {
  if (!isHexPayload(hex)) return undefined;
  return decryptQrcBytes(padToBlock(Buffer.from(hex, 'hex')));
}

/**
 * 这段文本看起来是不是「密文的 hex」。
 *
 * 为什么要判：同一条接口在不同参数下，**同一字段可能是密文、也可能是明文**
 * （实测 `crypt: 0` 时 `trans` 是 base64 的明文 LRC，而 `lyric` / `roma` 仍是 hex 密文）。
 * 判据取严一点：长度是偶数、全部 0-9A-F、且够长（短字符串误判成 hex 的概率太高）。
 */
export function isHexPayload(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 64 &&
    value.length % 2 === 0 &&
    /^[0-9A-Fa-f]+$/.test(value)
  );
}

/**
 * 读一条可能是密文 hex、也可能是 base64 明文的歌词字段。
 *
 * 顺序是「先当密文试，失败再当 base64」：明文那一支的 base64 极少整串都是十六进制字符，
 * 就算真撞上了，解密那一步也会因为 zlib 校验失败而返回 `undefined`，于是自然落到 base64。
 */
export function decodeQqLyricField(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (isHexPayload(value)) {
    const decrypted = decryptQrcHex(value);
    if (decrypted !== undefined) return decrypted;
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * 去掉 QRC 外面的那层 XML：解开后的正文是
 * `<QrcInfos><QrcHeadInfo …/><LyricInfo><Lyric_1 LyricType="1" LyricContent="[ti:晴天]…"/></LyricInfo></QrcInfos>`
 * 这种壳子，真正的逐字文本在 `LyricContent` 属性里（并且做了 XML 实体转义）。
 *
 * 没有壳子（直接就是 `[0,1000]你(0,300)` 这种行）时原样返回 —— `parseQrc` 两种都吃。
 * 有多个 `Lyric_n` 时只取**第一个有内容的**（约定里 Lyric_1 才是原文）。
 */
export function unwrapQrcXml(text: string): string {
  if (!/<QrcInfos|<LyricInfo|LyricContent=/i.test(text)) return text;
  const contents: string[] = [];
  for (const match of text.matchAll(/LyricContent\s*=\s*"([\s\S]*?)"/gi)) {
    const raw = match[1] ?? '';
    if (raw !== '') contents.push(unescapeXml(raw));
  }
  if (contents.length === 0) return text;
  return contents.join('\n');
}

/** XML 实体还原（`&amp;` 这类；十进制/十六进制数字实体也一起处理）。 */
function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
