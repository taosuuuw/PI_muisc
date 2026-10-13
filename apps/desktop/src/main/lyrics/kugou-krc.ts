/**
 * 酷狗 KRC 歌词的解密封包。
 *
 * KRC 不是什么专有二进制格式，而是**一个 XOR + zlib 的包**：
 * 前 4 字节是 ASCII 魔数 `krc1`，之后整段与一枚 16 字节固定密钥循环异或，
 * 异或完就是 zlib 流，解压出来是可读歌词文本。
 *
 * 算法与密钥照抄社区里被广泛验证过的那一套（`MakcRe/KuGouMusicApi` 的
 * `util/util.js` 的 `decodeLyrics`；LX Music / UnblockNeteaseMusic 用的是同一组常量），
 * 我们只把它写成本仓库的风格：纯函数、失败返回 `undefined`、不引第三方解压库
 * （Node 自带的 `zlib` 就是同一个算法）。
 *
 * **踩过的坑**：密钥是 16 字节不是 8 字节。用 8 字节那版（`40 47 61 77 5e 32 74 47`）
 * 解出来的永远是「incorrect header check」——而它的前 8 位正好是 16 字节版的前 8 位，
 * 所以只看开头很容易以为密钥是对的。
 */
import { inflateSync } from 'node:zlib';

/** 16 字节 XOR 密钥（循环使用）。 */
export const KRC_XOR_KEY: readonly number[] = [
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
];

/** KRC 的魔数（前 4 字节）。 */
export const KRC_MAGIC = 'krc1';

/**
 * 把一份 KRC 字节解密成歌词文本；不是 KRC 或解密失败时返回 `undefined`。
 *
 * 调用方拿到 `undefined` 就该退回 lrc 档（`sources.ts` 的 `fetchKugouLyric` 就是这么做的）——
 * 宁可给逐行的歌词，也不要给一屏乱码。
 */
export function decryptKrc(input: Uint8Array | Buffer): string | undefined {
  if (input.length <= 4) return undefined;
  const raw = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (raw.subarray(0, 4).toString('utf8') !== KRC_MAGIC) return undefined;

  const body = Buffer.from(raw.subarray(4));
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (KRC_XOR_KEY[index % KRC_XOR_KEY.length] ?? 0);
  }
  try {
    const inflated = inflateSync(body);
    /*
     * 解压出来的第一个「字符」要丢掉：酷狗以 utf8 下发时正文带 BOM，
     * 上游实现（C# 的 `Encoding.UTF8.GetString(...)[1..]`）是无条件丢第一个字符的，
     * 所以这里必须**按 BOM 决定丢 1 还是 3 个字节**——只丢 3 或只丢 1 都会错。
     * 本机实测这一份的开头确实是 `EF BB BF`，走的是丢 3 字节那一支。
     */
    const skip =
      inflated[0] === 0xef && inflated[1] === 0xbb && inflated[2] === 0xbf ? 3 : 1;
    return inflated.subarray(skip).toString('utf8');
  } catch {
    return undefined;
  }
}

/** KRC 里 `[language:...]` 段的形状（社区约定，非公开文档）。 */
interface KrcLanguagePayload {
  content?: { language?: number; type?: number; lyricContent?: string[][] }[];
}

/**
 * 把 KRC 的 `[language:...]` 段解成「逐行的译文」。
 *
 * 这一段是一串 base64 过的 JSON，`lyricContent` 是**按行索引**的数组
 * （`lyricContent[i]` 就是正文第 i 行的译文，行内再按词切），
 * 所以它能和时间轴严格对齐——比按时间戳猜可靠得多。
 *
 * `type` 决定这一段是什么：`1` = 翻译，`0`（以及缺省）= 音译/罗马音。
 * 实测酷狗给英文歌的 `type: 1` 段就是中文翻译。
 */
export function decodeKrcLanguage(raw: string | undefined): {
  translated: Map<number, string>;
  roman: Map<number, string>;
} {
  const translated = new Map<number, string>();
  const roman = new Map<number, string>();
  if (raw === undefined || raw === '') return { translated, roman };
  let payload: KrcLanguagePayload;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as KrcLanguagePayload;
  } catch {
    return { translated, roman };
  }
  for (const block of payload.content ?? []) {
    // 只有**明确写着 0** 的才算音译；缺 `type` 的按翻译处理（实测酷狗给英文歌的
    // 中文翻译就是 `type: 1` 且不写 `type` 的旧数据也存在）。
    const target = block.type === 0 ? roman : translated;
    const rows = block.lyricContent ?? [];
    rows.forEach((words, index) => {
      const text = words.join('').trim();
      if (text !== '' && !target.has(index)) target.set(index, text);
    });
  }
  return { translated, roman };
}
