/**
 * 浮名 = `fume`（用户 m08768 第 4 条）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **fume** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每一个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 * folia 原版是「一整张全屏 Canvas2D + pretext 排版 + 相机」；我们**不许新增依赖**（没有 pretext），
 * 所以这是一次 **DOM 重写**：整篇文章 = 绝对定位的块 + 逐字素 `<span>`，
 * 相机 = 一个 wrapper 的 `transform`，由 rAF 手写弹簧驱动。这是本主题最大的一处近似。
 *
 * 观感：全部歌词被**确定性打乱**后排成多列铺在一张比视口大的「纸」上（构图 ≠ 时间顺序，
 * 这是 fume 的灵魂），文字用**逐字素打印**的方式亮起（没有位移 / 缩放 / 旋转），
 * 相机像拍纪录片一样跟着「正亮着的那一句」推进 / 缩放，插值方式（定格 / 平滑）与跟手速度在设置页可调，
 * 并在没人唱的时候轻微漂移。
 *
 * === 用户第 9 轮第 1 条（浮名：「歌词左右两片中间的空白完全可以去掉，让两片歌词挨在一起」）===
 *
 * 主人给的那张浮名裁图（1211×456）量出来：左栏几块短句的墨迹宽 ≈150 图像 px（≈293 世界 px），
 * 而它占的地是一整栏 **588px** ⇒ 每栏右侧空着 ~295px，四栏叠起来就是那道竖空白。
 * 根因不是 `gap`（那只有 6~14px），是**块的盒子等于整栏**、而文字左对齐。
 *
 * 本轮改两条（数值与推演都写在 `SLOT_DIVISOR` / `packFumeSlots` 的注释里）：
 *  1) **盒宽缩到文字自然宽**（`min(帽宽, 自然宽 × 1.02 + 2)`）：短句不再占地，长句（自然宽 > 帽宽）
 *     的折行行为与改造前逐位相同；
 *  2) **落位从「四根柱子」换成「细槽」**：`x = 起始槽 × slotPx`，净空 = `gap × 1.6`
 *     —— 短块与下一块之间从 ~295px 收到 ~22px，主人口中的「挨在一起」。
 *
 * === 本轮改造（用户第 5 轮第 1 条：「高亮字左边的歌词部分颜色褪去，右边的歌词部分保持一个暗淡的颜色」）===
 * 1) **播放头右边 = 实体暗色**（不再是「中性浅色 × 0.44 不透明度」）：`FumePaint.pending` 改成
 *    `mixColor(accent, 底色, LEAD_TINT_MIX = 0.55)` —— 同一支主题色的**暗档**，满亮度铺过去。
 *    半透明那层会让封面底色漏上来：用户图 1 里右边那截发粉就是这么来的（量到前 15% 亮像素
 *    R=205/G=166/B=164 = 封面色，不是字色）。用户要的「暗淡的颜色」是**字自己有色、只是暗**。
 * 2) **左边（唱过）继续褪成中性白，亮度按图量到的档位**：`FUME_TRAIL_DIM_DARK` 0.85 → 0.78
 *    （目标图左侧 ≈ 0.71 白），色相一个字不动 —— 「颜色褪去」就是褪到没有颜色。
 * 3) 右边仍然**不许有渐变**：整段一支色、一个亮度（第 4 轮那条判据不变）。
 * 4) 量目标图（图 2）得到的两条判据：右侧亮度 ≈ 左侧的 0.52、饱和度反而**高于**左侧
 *    （24.5 : 12.8）⇒ 层级是「左侧亮的无色字 / 右侧暗的有色字」，与上一版正好相反。
 *
 * === 本次改造（用户第 4 轮第 1 条：右边等待段要是「浅色」、高亮时才加深、褪色快慢跟镜头速度走）===
 * 1) **等待段 = 主题色往「底色」里混**（不再是「混白 + 压透明度」）：`FumePaint.lead` 改成
 *    `mixColor(accent, 底色, LEAD_TINT_MIX = 0.55)`。暗底上得到图 2 那种暗橄榄、亮底上得到一层淡彩，
 *    两种底色都读得出「这是一支有颜色的字、只是还没轮到它」。旧版亮档把 `hot` 取成 `primary`
 *    （亮底上 primary 被对比度兜底压成近黑）⇒ 图 1 里有一段等待段**看起来就是常态原色**。
 * 2) **「浅 → 深」切成一条连续曲线**：`LEAD_DEEP_MAX = 0.55` —— 等待段最深只走到主题色的一半多一点
 *    （`FumePaint.pending` 就是这个点），剩下那 45% 留给「唱到它」的那一刻：起笔正好从等待段的末端
 *    接管，再随 `eased` 走到实心主题色 ⇒ 播放头扫过时那颗字刚好在那里变深，中途没有跳变。
 *    （**第 5 轮作废**：等待段改成实体暗色，`LEAD_DEEP_MAX` 换成 `LEAD_TINT_MIX` + `SING_DEEP_SPAN`。）
 * 3) **高亮色两种底色都取 `accent`**（`hot: accent`）：亮档不再拿 `primary` 当高亮色。
 * 4) **等待段亮度抬到 0.72 / 0.62**：浅色改由「与底色混合」承担之后，透明度只负责「读得清」，
 *    不再两处一起压（图 1 右边那团灰就是两处一起压出来的）。
 * 5) 「**褪色速度跟镜头速度**」这条——上一轮接入的 `FUME_TRAIL_SPEED_*`（逐帧读弹簧的屏幕速度
 *    `hypot(velocityX, velocityY)`、一阶低通、除以 320px/s 当速率倍率）——**逐字保留**，
 *    本轮只是把等待段的配色与它对齐（镜头走得快 ⇔ 唱过的那段褪得干净）。
 *
 * === 本次改造（用户 m00341 第 1 条·第三遍：镜头要平滑、褪色速度跟镜头速度、高亮别太深光别太重）===
 * 1) **镜头从「按字跳格」改成「跟打印前沿」**（用户：「浮名的镜头移动是平滑的，而不是现在这样顿挫的」）：
 *    第二遍把焦点取在那颗字的**框中心**上 —— 那是一条第每个字跳一格（本曲约 53px）的**阶梯**，
 *    弹簧只能一格一格追 ⇒ 看起来一顿一顿。现在 `resolveFocus` 取**打印前沿**（在那颗字的框里从
 *    左缘线性走到右缘，`progress = (ms − glyph.startMs) / glyph 时长`）⇒ 目标**连续单调**，
 *    镜头变成匀速平移（folia 原版就是「跟着打印前沿推进的纪录片镜头」）。
 *    代价是高亮的字相对画面中心有**半个字以内**的偏置，换来的是真正的平滑。
 *    弹簧同时**放软**：`CAMERA_STRENGTH_MAX` 2000 → 780、`CAMERA_DAMPING_MAX` 64 → 40、
 *    `FUME_FOLLOW_CATCHUP_MS` 90 → 160ms（ω ≈ 24.8、ζ ≈ 0.68）—— 目标已经连续，硬弹簧只会把
 *    顿挫做得更明显。**限速**仍按整句时长算 ⇒ 换句那趟飞行的巡航速度不变。
 * 2) **褪色速度跟镜头速度挂钩**（用户：「歌词渐变褪色到速度随镜头移动速度有所变化」）：
 *    逐帧读弹簧的屏幕速度 `hypot(velocityX, velocityY)`，一阶低通（`FUME_TRAIL_SPEED_SMOOTH = 4`）后
 *    除以 `FUME_TRAIL_SPEED_REF = 320px/s`，夹在 `[0.55, 1.8]` 当**褪色速率倍率**传进
 *    `paintActiveGlyphs`（`trailDurationSec /= rate`）。镜头追得越快、已经唱过的那一段褪得越干净；
 *    镜头几乎不动时颜色慢慢褪。
 * 3) **高亮的字不再压那么深、辉光收小**（用户：「高亮的字颜色太深辉光太重，应该如图 1 的样子」）：
 *    `ACTIVE_DARK_MIX` 0.26 → 0.08（高亮仍是那支主题色的实心字，只是比未唱段实一点点）；
 *    逐字素辉光 `GLYPH_GLOW_BASE/PER_FONT` 4/0.22 → 2.5/0.1、alpha `0.5+0.5` → `0.3+0.2`；
 *    整行辉光 alpha `0.16/0.12 + envelope×0.26/0.2` → `0.09/0.06 + envelope×0.13/0.1`。
 *
 * === 上一轮改造（用户 m00002 第 1 条·第二遍：镜头跟着「高亮的字」走 + 左边渐变放慢并压暗 + 右边渐变加深）===
 * 1) **镜头焦点 = 正在唱的那颗字素**（不再是句中心）：高亮在句内会一颗颗往前爬，而句中心是死的。
 *    每块的量测（`probeOf`）除文字并集外还**逐颗**记下字素框，`resolveFocus` 用
 *    `fumeFrontGlyphIndex`（= 「已经开唱、且最晚开唱的那一颗」，词间空档继续认刚唱完的那颗）
 *    挑出焦点那颗（第三遍起焦点再往前推到「打印前沿」，见上），横纵都压到视口正中
 *    （`CAMERA_FOCUS_Y = 0.5`）。镜头正对着的那颗字素挂 `data-fume-focus="true"`
 *（可判定接缝，冒烟探针直接量它）。
 * 2) **横向那条「当前句文字比视口宽时钉住左缘」的守卫整条拆掉**：句中心对焦的年代它是兜底；
 *    跟着高亮字走之后，一句唱过一半、焦点字离句首超过半屏时它**每帧都生效** ⇒ 高亮的字被钉在
 *    右半边，用户要的「始终位于窗口中心」当场失效。现在 `focusCameraOffset` 只剩
 *    `anchor − focusWorld × scale` 一条式子，播放期没有任何夹取（结尾缩镜那条另算，与缩略图配套）。
 *    已经唱过的那一截随镜头滑出左边，正是「跟着高亮推进」的应有之义。
 * 3) **高亮左边的渐变放慢**（用户：「高光左边的渐变褪色太快」）：逐字素 colour trail 的时长
 *    0.2~0.45s → 0.55~1.35s（按行长的 `TRAIL_RATIO_HERO/BODY = 0.5 / 0.56`），块级淡出
 *    `FUME_PASSED_FADE_MS` 260 → 900ms，重绘窗口 `FUME_PASSED_TRAIL_MS` 随之变长。
 * 4) **暗色模式下左边压暗**（用户：「在暗色模式下太亮了」）：暗底上「唱过」那段是纯白，比高亮那支
 *    饱和色还刺眼 ⇒ 新增 `FumePaint.passedDim`（暗档 `FUME_TRAIL_DIM_DARK = 0.6`、亮档 1），
 *    在 `paintActiveGlyphs` 里随 colour trail 的 `p` 把字素**不透明度**乘下去。压的是亮度不是色相：
 *    落点仍是那个中性常态色（用户上一轮要的「褪回原色」、以及冒烟里「唱过 / 还没唱到同色」的判据
 *    都继续成立）。
 * 5) **高亮右边「初始颜色深度太浅」**（用户图 1）：句内未唱段的远端亮度 0.5 / 0.4 → 0.6 / 0.5，
 *    远端色混白比例 `LEAD_TINT_MIX` 0.5 → 0.28 ⇒ 图 1 里那团灰变回「看得见的那支主题色」，
 *    「越靠近播放头越重」的那道渐变仍然在。
 *
 * === 上一轮改造（用户 m00002 第 1 条·第一遍）===
 * 1) **焦点取「文字」的中心，不再取块框中心**：块框是排版列宽，文字在框里 `text-align: left` —
 *    hero 块跨两列（`paperWidth ≈ 1.95 视口宽` ⇒ 框 ≈ 0.98 视口宽），短句的文字只占框左边一小截，
 *    拿框中心当焦点就成了「框居中了、字却停在左半屏」。那一轮的解法是量**全部
 *    `.pi-lyricfume__glyph` 的并集外接框**（现由 `probeOf` 一并给出，量到就按块号缓存；
 *    刻意不用 `Range`、也不用 `.pi-lyricfume__text` —— 后者含 `display: block` 的译文行，
 *    会把并集撑大、把中心带偏）；本遍把它降级成「字素框量不到时的退路」。
 * 2) **纵向不再夹取**：删掉 `clampCameraOffset`，「纸面必须盖住视口」那条守卫整个拆掉 —— 曲首第一行
 *    （`y ≈ 0`）正是被它钉在窗口顶部，看起来就是「高亮句没在中心」。现在 `targetY = viewportHeight ×
 *    CAMERA_FOCUS_Y − focus.worldY × scale`，焦点永远落在视口正中；纸面出画只意味着露出沉浸式
 *    背景图（`world` 本来就没有底色）。结尾缩镜（`fumeOutroOffset`）与静态渲染路径（`paintStatic`）
 *    都按同源改法。
 * 3) **「唱过」的褪色曾一度提速**：块级淡出 900 → 260ms、colour trail 收到 `[0.2, 0.45]s`；
 *    第二遍按用户反馈（「褪色太快」）全部放回去了，见上面第 3 条。
 * 4) **高亮句右边「等待」段的渐变加深要看得见**：`paintActiveGlyphs` 里「进度未到」的字素原来被压到
 *    `WAIT_ALPHA_*`（0.035 / 0.06 —— 那是**整句还没唱到**时的亮度），`fumeLeadColor` 那道颜色渐变等于被
 *    洗掉。改成 `LEAD_ALPHA_FAR_*` → `PRINT_FRONT_ALPHA = 0.82`，按「离播放头的距离 / `LEAD_TINT_MS`」
 *    插值：越靠近播放头越亮，颜色由 `fumeLeadColor` 给。
 *
 * === 上一轮改造（用户第十四轮第 3 条：镜头中心跟随当前句 + 速度 / 追焦方式可调）===
 * 1) **焦点从「正在打印的字素」换成「当前句的中心」**：目标机位由激活块（`activeBlock ?? viewBlock`）
 *    的**文字**中心求出（当时取块框中心，已在用户 m00002 第 1 条里改成文字外接框中心，见上）。
 *    取景倍率与改造前逐位相同：缩放目标仍只看 `lineHeightPx × 1.34`，与焦点取在块内哪个点是两件事。
 * 2) **插值换成对 `dt` 无关的隐式阻尼弹簧**（`springStep`）：原来那条显式欧拉
 *    `v += ((target - x) × k - v × c) × dt` 有稳定性条件（约 `ω·dt < 2`）。原来 `dt` 被
 *    `clamp(…, 1/240, 0.05)` 兜着，`k` 最大 780 ⇒ `ω·dt` 已经到 1.4 贴着边界；速度倍率会让
 *    `k` 按 `s²` 涨，`s = 2.5` 时 `ω·dt ≈ 3.5`，特征值 |λ| ≈ 2.25 ⇒ 镜头会自我放大地抖。
 *    隐式解没有稳定性条件，`fpsCap` 丢帧（`dt` 变大）/ 拖窗口都抖不坏。
 * 3) **速度倍率 = 弹簧自然频率的倍率**：`ω' = ω × fumeCameraSpeed`（⇔ `k' = k × s²`、`c' = c × s`，
 *    阻尼比 `ζ` 与过冲手感不变），`maxVelocity` 同量纲也跟着乘 `s`。`s = 1` 时换算退化成恒等，
 *    就是改造前那组常数（详见 `springStep` / `cameraSpring` 的注释）。
 * 4) **追焦方式**：`fumeCameraFollow === 'snap'`（定格）= 切句瞬间直接换机位、速度清零、没有插值；
 *    `'smooth'`（默认）= 走弹簧。idle 浮动两种模式都保留（它由 `motionAmount` 管，不属于「追焦插值」）。
 *    `prefers-reduced-motion` 仍走 `paintStatic` 的静态取景（不动相机），语义不变。
 *
 * === 本次修复（用户第九轮第 4 条：三套动效主题铺满整个 app 视口，任意尺寸 / 全屏都不变形不留白）===
 * 1) **舞台铺满**：`styles/lyric-themes.css` 里三套主题的舞台盒子改成 `position: absolute; inset: 0`
 *    ——包含块是 `position: relative` 的 `.pi-home__stage`（播放页视口那一格）。不再用
 *    「负外边距去抵消 `.pi-home__stage-lyrics` 的 padding」那种必须跟 `global.css` 的
 *    `108px / 24px / 92px` 和两个媒体查询逐像素对齐的写法（对不齐就露边、会被裁）。因此
 *    `useFullStageSize()` 量到的就是整个视口，窗口任意尺寸 / 最大化 / 全屏都跟着走。
 * 2) **相机不再把纸面推出视口**：新增 `frameCameraOffset()`（**用户 m00002 第 1 条起已被
 *    `focusCameraOffset` 取代**，纸面覆盖那条守卫拆掉了，只留「当前句文字比视口宽时钉住左缘」），
 *    同时解「焦点落在视口锚点」与「缩放后的纸面盖住视口」两条约束。旧写法平移量漏了 `× scale`
 *    （世界层是 `translate3d(x, y, 0) scale(s)`，世界点 `w` 的屏幕位置是 `x + w × s`），于是
 *    scale > 1 时焦点被 `w × (s − 1)` 推离锚点——窗口越宽 / 越高越明显，靠后的列会被推出屏幕。
 * 3) 纸面高度撑到内容真实边界：块放不下时会被「再铺一张纸」推到 `paperHeight` 之下，
 *    而盖满约束是拿纸面矩形算的（见 `buildFumePlan` 结尾的 `contentRight / contentBottom`）。
 *
 * === 已修复（用户第八轮第 4 条：全屏 / 多语言 / 颜色跟随歌曲）===
 * 1) **尺寸来源**：不再走「`useElementSize` 量歌词盒子 + 量不到回退 `window.innerWidth/Height`」
 *    的双路径，改用 `useFullStageSize()`；窗口缩放 / 转向由 `ResizeObserver` + `resize` 事件重算
 *    （重算会重建 plan，相机重新对齐）。
 * 2) **多语言自适应**：折行估算（`estimateRowCount`）与相机焦点（`resolveFocus`）里的宽度
 *    从 `estimateTextWidth()`（CJK 每字 1em、其余 0.55em 的**估算**）换成 `measureTextWidth()`
 *    （离屏 canvas `measureText`，字体栈取舞台的 computed `font-family`，字重按 hero 780 / body 640）；
 *    词间空格宽度只在「用空格分词」的语言里加（`usesWordSpaces`）。字距 / 字号 / 列数全都不用改：
 *    真实字宽一准，行数就准，块高也就准（原来拉丁文会因低估宽度而**块高偏小、块与块重叠**）。
 * 3) **颜色跟随歌曲**：删掉 `paletteRef` 的硬编码初值 `#5ab6ff`，改用 `useResolvedThemeColors()`
 *    —— 祖先注入的 `--pi-th-primary / --pi-th-accent / --pi-th-surface`（播放页按当前歌曲封面注入）
 *    优先，`theme` palette 兜底；**每帧从 ref 现读**，所以换歌后下一帧就换色（原来是把
 *    `paletteRef.current` 的对象在 effect 里捕获成常量，换色要等整条 rAF 依赖变化才生效）。
 *    正文颜色再按 `--pi-th-surface` 过一遍 `ensureContrast()`，保证跟歌曲走的配色下仍读得清。
 * 4) 行元素补上 `data-lyric-line` / `data-line-time`（父代理要做「点歌词行 seek」的事件委托）。
 *
 * 数值表（来自任务书 / folia 源码研究报告）：
 * - 纸面：`paperWidth = clamp(max(vw × 1.95, vw + 520), 920, 2400)`、`targetHeight = max(vh, 240) × 2.45`；
 *   列数 `paperWidth >= 1120 ? 4 : >= 760 ? 3 : >= 500 ? 2 : 1`；
 *   `gap = clamp(round(paperWidth × (cols >= 4 ? 0.0065 : cols === 3 ? 0.0085 : 0.0115)), 6, 14)`；
 *   `columnWidth = (paperWidth - gap × (cols - 1)) / cols`。
 * - 块宽：**用户第 9 轮第 1 条**起 = `min(帽宽, 文字自然宽 × 1.02 + 2)`，帽宽 body = `columnWidth`、
 *   hero：`cols <= 1 → paperWidth`、`cols === 2 → columnWidth × 1.5 + gap × 0.5`、
 *   否则 `columnWidth × 2 + gap`（**帽宽只用于字号口径与折行上限**，盒子本身缩到文字宽）。
 * - 放置（**用户第 9 轮第 1 条**：细槽贴紧）：槽宽 `slotPx = max(24, round(columnWidth / 12))`、
 *   净空 `gutter = max(round(gap × 1.6), 10)`；每块占 `ceil((盒宽 + gutter) / slotPx)` 个槽，
 *   起始槽取「被覆盖槽最大高度最小」者（同高取最靠左），高度表按槽更新；
 *   行按 `seededFraction(seed)` **确定性打乱**后再排；块前空隙 `BLOCK_GAP_HERO/BODY`（都是 0）。
 *   纯函数 `packFumeSlots`，四个不变量在 `FumeTheme.test.ts` 里钉住。
 * - 字号：hero `clamp(width / max(sqrt(字素数 + 词数 × 1.4) × 1.5, 4.5), 24, 54)`、
 *   body `clamp(width / max(sqrt(density) × 2.25, 7), 14, 28)`，`density = 字素数 + 词数 × 1.4`；
 *   `lineHeight = fontPx × (hero ? 1.02 : 1.06)`；字重 hero 780 / body 640。
 * - hero 判定：`isChorusLine && 字素数 <= 22` 直接用；否则要
 *   `4 <= 字素数 <= 28 && |index - total/2| / max(total,1) < 0.72 && ((index+1) % 6 === 0 || seededFraction(seed+index) > 0.965)`；
 *   若全片没有 natural hero，再按 `居中分 × 0.62 + 长度分 × 0.34 + 副歌分 + seededFraction(...) × 0.04` 选一个
 *   （长度分：6..22 → 1、<= 28 → 0.72、否则 0.36；副歌分 0.28），再不行取最短非空块。
 * - 三态：waiting `alpha = hero ? 0.06 : 0.035`；打印前沿固定 `alpha = 0.82`；
 *   active `p = clamp((t - glyphStart)/glyphDuration + 0.16, 0, 1)` 再 easeOutCubic，
 *   `alpha = mix(hero ? 0.06 : 0.035, hero ? 0.985 : 0.92, eased)`，
 *   颜色 `mix(primary, activeColor, 0.22 + eased × 0.78)`，
 *   `text-shadow: 0 0 <(4 + fontPx × 0.22) × eased × boost>px <activeColor@(0.4 + eased × 0.44)>`，
 *   `boost = (chaotic ? 1.15 : calm ? 0.72 : 0.92) × 1`；
 *   passed `alpha = hero ? 0.74 : 0.58`、辉光 `(2 + fontPx × 0.1) × 0.65 × passedGlowBase`、
 *   `passedGlowBase = chaotic ? 0.95 : calm ? 0.35 : 0.62`；`linePassCutoff = min(行渲染结束, 下一行 startMs)`。
 * - 整行辉光：`lineGlowAlpha = (hero ? 0.16 : 0.12) + envelope × (hero ? 0.26 : 0.2)`、
 *   `lineGlowBlur = (hero ? 12 : 8) + envelope × fontPx × (hero ? 0.7 : 0.52)`（颜色 accent），
 *   `envelope` 是 `peak = 0.8` 的「先涨后落」包络（`t <= 0.8` 用 `easeOutCubic(t / 0.8)`，
 *   否则 `1 - easeInCubic((t - 0.8) / 0.2)`）。
 * - colour trail：亮完之后颜色从 activeColor 混回 primary，
 *   `trailDuration = clamp(lineDuration × (hero ? 0.42 : 0.52), 0.45, 1.45)`s、
 *   `p = ((t - trailStart) / trailDuration) ^ 1.35`、`fill = mix(activeColor, primary, 0.18 + p × 0.82)`。
 *   落点色由 `FumePaint.pending` 给：**亮档 = `ink` 常态白**（上面这一路，逐位不变）；
 *   **暗档 = `FumePaint.hot` = 封面那支鲜艳色**（用户 m00001：暗色模式下浮名的当前句整体是那支粉、
 *   未唱到的字素同色，直到整句唱完才由 `phase === 'passed'` 的 900ms 逐块淡出落到常态白；
 *   详见 `FumePaint` / `buildFumePaint` 的注释）。
 * - 相机（第十四轮第 3 条改造后：`springStep` 的隐式阻尼弹簧，作用在 wrapper 的
 *   `transform: translate3d(x, y, 0) scale(s)`，`transformOrigin: '0 0'`）：
 *   目标 = **当前激活块（`activeBlock ?? viewBlock`）的中心**（`block.x + width / 2`、`block.y + height / 2`）；
 *   `targetLineHeight = clamp(min(vw, vh) × 0.12, 64, 150)`（用户本轮第 2 条把比例从 0.09 抬到 0.12：
 *   镜头里的歌词整体放大三分之一）、
 *   `scale = clamp(targetLineHeight / (lineHeightPx × 1.34), 0.88, 2.2)`（硬钳制 `CAMERA_SCALE_HARD_MIN 0.22 / MAX 2.24`，
 *   再按 `motionAmount` 缩放「离 1 有多远」）；
 *   位置弹簧 `ω = sqrt(clamp(15.8 / max(duration, 0.05)², 260, 780)) × fumeCameraSpeed`、
 *   `ζ = clamp(sqrt(k) × 1.36, 24, 40) / (2 × sqrt(k))`（≈ 0.68~0.74，欠阻尼小过冲，与速度倍率无关）、
 *   `maxVelocity = clamp(distance / max(duration × 0.28, 0.028), 2600, 8800) × fumeCameraSpeed`；
 *   缩放弹簧 `ω = sqrt(108) × fumeCameraSpeed` / `ζ = 21 / (2 × sqrt(108)) ≈ 1.01`（临界阻尼附近）；
 *   `fumeCameraFollow === 'snap'`（定格）时位姿与速度直接硬设，不过弹簧。
 * - idle 浮动（正常强度）：`distance 18px / duration 7s / scaleAmplitude 0.011`；
 *   `x = sin(phase × 0.74 + 0.8) × d × 0.34`、`y = sin(phase) × d + sin(phase × 0.5 + 1.1) × d × 0.22`
 *   （`phase = (now / 1000 / 7) × 2π`），世界位移要除以当前 scale；初始相机 = 文章中心、`scale 1.18`。
 *
 * 本仓库的取舍（都写进交付报告）：
 * - **不新增依赖 / 没有 pretext**：排版用 `measureTextWidth()`（canvas `measureText`，取不到时
 *   内部回退 `estimateTextWidth()`）量宽 + 自己实现的贪心列填充，
 *   块高是「按量出来的行数」推出来的，不是真实字形测量 —— 换行位置与原版不会逐像素一致。
 * - 只挂**相机附近 12 行**的块进 DOM（`blockIndex ∈ [viewIndex - 8, viewIndex + 12]`），
 *   原版是 canvas 全量绘制 + 屏外剔除；我们靠 React 只渲染窗口内的块。
 * - 逐字素 `<span>` 按**词**分组缓存 DOM，每帧只改已存在节点的 `style.opacity / color / textShadow`，
 *   不 setState、不新建 / 销毁节点、不查 DOM。
 * - 「重复文本层做整行辉光」原版是 canvas blur；我们改成给块加 `text-shadow`（同样数值），更可靠。
 * - 没有 WebAudio：`motionEnergy` 取恒定 1；`boost` 取常值 1（不做桥接 / 瞬移）。
 * - 译文按任务书样式自写在块内（右下角、更小更淡）。
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  clamp,
  ensureContrast,
  isChorusLine,
  measureTextWidth,
  mixColor,
  parseRgb,
  relativeLuminance,
  resolveCssColor,
  rgba,
  seededFraction,
  createFrameGate,
  tuningOf,
  useElementFontFamily,
  useFullStageSize,
  usePositionClock,
  usePrefersReducedMotion,
  useResolvedThemeColors,
  usesWordSpaces,
  wordColorOf,
  type LyricPalette,
  type LyricThemeProps,
  type RgbColor,
  type ResolvedThemeColors,
  type StageLine,
} from './types';

/* ------------------------------------------------------------------ *
 * 数值常量（folia fume 那一套）
 * ------------------------------------------------------------------ */

const PAPER_WIDTH_MIN = 920;
const PAPER_WIDTH_MAX = 2400;
const PAPER_WIDTH_VW = 1.95;
const PAPER_WIDTH_EXTRA = 520;
/**
 * 纸面高度 = 视口高 × 这个倍数。
 *
 * **用户本轮第 1 条**（图 1：「歌词间隙太大、密度太低」）2.45 → **2.15**：同样的视口里多出一整屏
 * 的内容（相机视野不变、只是纸更紧凑）⇒ 屏上同时看得见的句子更多，块与块之间的空档变小。
 */
const PAPER_HEIGHT_MULT = 2.15;
const PAPER_HEIGHT_FLOOR = 240;
/** `gap` 的三个基数：4 列 / 3 列 / <= 2 列。 */
const GAP_RATIO_4 = 0.0065;
const GAP_RATIO_3 = 0.0085;
const GAP_RATIO_2 = 0.0115;
const GAP_MIN = 6;
const GAP_MAX = 14;
/**
 * === 用户第 9 轮第 1 条（浮名）：「歌词左右两片中间的空白完全可以去掉，让两片歌词挨在一起」 ===
 *
 * 病根：**每一块都按栏宽占地**（`width` = 一整栏，hero 跨两栏），而块里的文字是左对齐的 ——
 * 短句（这种日文歌词常见 4~8 个字）在一栏里只占三分之一宽，剩下那三分之二被这块地占掉、
 * 别的块进不来，看起来就是一道贯穿整屏的竖空白。
 *
 * 量测（主人给的浮名截图，1211×456 那张裁图）：左栏那几块短句的墨迹宽 ≈ 150 图像 px
 * ⇒ 按缩镜后的相机倍率反推约 **293 世界 px**；而它所在的栏宽是 **588px** ⇒
 * **每栏右侧空着约 295px**。四栏叠起来就是主人图里那道空白。
 *
 * 改法两条：
 *  1) **块的盒子缩到文字宽**（`boxWidth`，见 `buildFumePlan` 的第 3 步）——只有真的装不下
 *     （自然宽 > 栏宽 / hero 宽）时，盒子才等于栏宽、文字才折行；
 *  2) **落位从「四根柱子的栏」换成「细槽」**——短块只占它自己那点宽，下一块贴着它右边落，
 *     不再等下一根柱子（原来的落位是 `x = column × (columnWidth + gap)`，一颗柱子一颗柱子跳）。
 */
const SLOT_DIVISOR = 12;
const SLOT_MIN_PX = 24;
/**
 * 相邻两块之间的**横向净空**（世界 px）= `gap × 这个倍数`。
 *
 * 不能取 0：两块的字会直接粘在一起（主人要的是「挨在一起」不是「叠在一起」）。取 `gap × 1.6`
 * ——四栏时 `gap = 14` ⇒ 22px，比原来那道 ~295px 的空白小一个数量级，同时保住可读性。
 */
const GUTTER_RATIO = 1.6;
/**
 * **用户 m00597 第 1 条**：「现在的歌词的间隙太大」——整块的**纵向间距**由这三个数决定，
 * 原来是「行数 × `lineHeightPx × 1.34` + `lineHeightPx × 0.35`，块前再留 hero 0.2 / body 0.08」，
 * 单行块的推进量 ≈ **1.77~1.89 个行高**，看着就是「一行字、一行空」。
 *
 * DOM 里真实的行距就是 `lineHeightPx`（`--pi-fume-line-height`），所以排版用的行距倍数只要
 * **不小于 1** 就不会让块内两行字叠在一起。现在收到：
 *   · `BLOCK_ROW_PITCH = 1.12`（块内行距，留 12% 余量给下伸部与逐字素辉光）；
 *   · `BLOCK_TAIL_RATIO = 0.12`（块尾余量，原 0.35）；
 *   · 块前空隙 hero 0.12 / body 0.04（原 0.2 / 0.08）。
 * 单行块的推进量 ⇒ hero 1.36 / body 1.28 个行高，与用户图 1 里那种「一行挨着一行」一致。
 * 注意：相机取景用的行高（`resolveFocus` 的 `lineHeightPx × 1.34`）**没有动** —— 那是取景倍率的
 * 口径，和排版间距是两件事，改它会把镜头拉近一档。
 *
 * === 用户本轮第 3 条（「浮名的歌词上下空隙还可以更小一点」，图 1 = 现在 / 图 2 = 目标） ===
 *
 * 上面那版（行进量 hero 1.36 / body 1.28 个行高）对着图 2 逐像素量还是偏松：
 *   · 图 1（旧口径）左栏相邻两条墨迹之间留 ~7px，行心距 ÷ 字号 ≈ **1.41**；
 *   · 图 2（目标）同一栏里两条墨迹几乎相接（间隙 0~1px），行心距 ÷ 字号 ≈ **1.07** ——
 *     也就是「行心距 = 行高本身」，块与块之间**一点额外留白都不加**。
 *
 * DOM 里这两条线的真实行距就是 `--pi-fume-line-height`（= `fontPx × 1.06`，块元素没有
 * padding / margin），所以「行心距 = 行高」在排版侧就是：块内步进 = 行高、块尾余量 0、
 * 块前空隙 0。推进量于是恒等于 `lineHeightPx`，与图 2 的 1.07 对上（1.06 + 亚像素取整）。
 *
 * 只动**排版**这三个数：`lineHeightPx` 本身（`fontPx × 1.06` / hero `× 1.02`）与相机取景
 * （`resolveFocus` 的 `× 1.34`）都一个字节没改 —— 字的大小与镜头倍率不受影响，收紧的只是间距。
 */
const BLOCK_ROW_PITCH = 1.0;
const BLOCK_TAIL_RATIO = 0;
/**
 * 块间距（相对行高）。**用户 m00597 第 1 条**：0.12 / 0.04 → 0.08 / 0.03；
 * **用户本轮第 3 条**（图 2）：再收到 **0 / 0** —— 纸面上没有「块前空隙」这一层了，
 * 下一块的字紧跟上一块（块与块之间的视觉间隙全部由行高自带的行距给出）。
 */
const BLOCK_GAP_HERO = 0;
const BLOCK_GAP_BODY = 0;
/** 字号：hero / 正文各自的上下限（folia fume 的原始数值）。 */
const FONT_HERO_MIN_PX = 24;
const FONT_HERO_MAX_PX = 54;
/**
 * **用户本轮第 1 条**（原话：「歌词大小分为普通和大字幕歌词，大小比例如图 2 所示」）：
 * **普通块 = 大字幕块 × 0.6**。
 *
 * 图 2 是同一帧上两颗**完整可见**的字，所以这是最干净的一条量测：
 * 「猝不及防缘分照面」（普通）≈ 62.5px/字、「远山流水 不及你眉眼」（大字幕）≈ 104.5px/字 ⇒ 0.60；
 * 图 1 交叉验算同向：右侧那行普通句 ≈ 54.5px/字、大字幕句 ≈ 105px/字 ⇒ 0.52。取 **0.6**。
 *
 * 历史：旧公式（除数 2.25、上限 28px）给的是 0.65 左右，但那个 0.65 是**被上限夹出来的副产品**，
 * 与窗口宽 / 句子长短强相关（长句会更小、短句会顶到上限）；上一版曾抬到 0.9（「正文接近高亮句」），
 * 按本轮第 1 条的图 2 改回 0.6。做法仍然是「与 hero 共用同一条公式、只差这个乘数」——
 * 于是「普通 ÷ 大字幕」恒等于 0.6，与窗口宽、栏数、句子长短都无关（只差 `fontScale`，两边同乘）。
 */
const FUME_BODY_TO_HERO = 0.6;
/** hero 字号公式（folia fume 原式）：`宽 / max(√密度 × 1.5, 4.5)`，夹在 `[24, 54]`。 */
const FONT_HERO_DIVISOR = 1.5;
const FONT_HERO_DIVISOR_FLOOR = 4.5;
/**
 * 正文下限：只在「极小窗口 + `fontScale = 0.8`」这个最角落被它托一下（那时比值会略大于 0.6，
 * 因为它是绝对像素值）；正常窗口下正文基准 ≥ 24 × 0.6 = 14.4px，用不到它。
 */
const FONT_BODY_MIN_PX = 14;
/**
 * 正文上限 = 大字幕上限 × 上面那个比例（**向上取整**：32.4 → 33）。
 * 向上取整是为了让「正文 ÷ 大字幕 = 0.6」在 `fontScale` 顶到 1.3 时也成立 ——
 * 取 32 的话 `32 × 1.3 = 41.6 < 54 × 0.6 × 1.3 = 42.1`，上限会先咬住、比值掉到 0.59。
 */
const FONT_BODY_MAX_PX = Math.ceil(FONT_HERO_MAX_PX * FUME_BODY_TO_HERO);

/**
 * 一块歌词的字号（**纯函数**，用户本轮第 1 条：「普通 / 大字幕两级，比例如图 2」）。
 *
 * 两个入参都是「块自己的几何」：`heroWidth` 是这一行**当 hero 时会拿到的宽度**（跨栏 / 单列时整张纸），
 * `density` 是这一行的字素数 + 词数惩罚。普通块照样按 `heroWidth` 取基准、再乘 `FUME_BODY_TO_HERO`，
 * 于是「普通 ÷ 大字幕 = 0.6」这条关系与窗口宽、栏数、句子长短都无关。**纯函数**，不吃 DOM 就能回归
 * （见 `FumeTheme.test.ts`）。
 */
export function fumeFontPx(
  hero: boolean,
  heroWidth: number,
  density: number,
  fontScale: number,
): number {
  const heroFontPx = clamp(
    heroWidth / Math.max(Math.sqrt(density) * FONT_HERO_DIVISOR, FONT_HERO_DIVISOR_FLOOR),
    FONT_HERO_MIN_PX,
    FONT_HERO_MAX_PX,
  );
  const baseFontPx = hero ? heroFontPx : heroFontPx * FUME_BODY_TO_HERO;
  return clamp(
    baseFontPx * fontScale,
    FONT_BODY_MIN_PX,
    (hero ? FONT_HERO_MAX_PX : FONT_BODY_MAX_PX) * FONT_SCALE_MAX,
  );
}
/** 设置里 `fontScale` 的上限，跟 `LyricTuningSchema` 的 `.max(1.3)` 对齐。 */
const FONT_SCALE_MAX = 1.3;
/** 未打印字素的亮度（**整块**还没唱到那一档：贴在纸上的淡印子）。 */
/**
 * **整块还没唱到**的那一档亮度（贴在纸上的淡印子）。
 *
 * **用户本轮第 1 条**（图 1）：0.06 / 0.035 → **0.18 / 0.12**。图 1 里除了高亮那句，四周还能看清
 * 好几句「等着唱」的歌词 —— 密度感主要来自它们；原来的 3.5%~6% 在真实封面背景上等于隐形，
 * 于是屏上只剩高亮那一句，看着「空、稀」。抬到「看得见但仍然明显是配角」这一档。
 */
const WAIT_ALPHA_HERO = 0.18;
const WAIT_ALPHA_BODY = 0.12;
/**
 * **用户本轮第 2 条**（图）：**已经播过**的歌词与**还没播到**的歌词要用**同一支原色**（黑/白），
 * 只差**深浅** —— 播过的更深、还没播到的更浅。
 *
 * 所以「还没唱到」的那些块不再直接用 `ink`，而是 `ink` 往**底色**里混 `WAIT_TINT_MIX`
 *（= 同一支原色的浅档）；`ink` 本身留给「已经唱过」。亮度那两支（`WAIT_ALPHA_*`）保持不变，
 * 深浅与亮度是两件事：混底色管「同一支色的深浅」，透明度管「离得多远」。
 */
const WAIT_TINT_MIX = 0.45;
/**
 * **用户（本轮）第 3 条**（第二遍）：「图 5 唱过的歌词颜色多深，图 6 是我们的实现，太浅了」。
 *
 * 浅色底（亮档）上「还没唱到」的那一档要**再往底色里混一截**（0.45 → 0.72），才配得上
 * 参考图里那种「近乎纸色的淡印子」；暗底维持 0.45（那一档已经对过图，不动）。
 */
const WAIT_TINT_MIX_LIGHT = 0.72;
/**
 * **用户（本轮）第 3 条**：亮底（浅色模式）单独一套不透明度 —— 已唱更实、未唱更淡。
 *
 * 暗底那四支（`WAIT_ALPHA_* = 0.18/0.12`、`PASSED_ALPHA_* = 0.74/0.58`）是照暗底参考图定的；
 * 换到亮底上它们把「唱过」和「还没唱到」拉到一起，正是用户说的「深浅不明显」。第一遍调到
 * 0.95/0.85 时用户仍说「唱过的太浅」，所以**唱过那两档直接拉满**（1.00 / 0.94，等于实体墨印）、
 * 未唱再压低一档（0.07 / 0.045）。
 */
const WAIT_ALPHA_HERO_LIGHT = 0.07;
const WAIT_ALPHA_BODY_LIGHT = 0.045;
const PASSED_ALPHA_HERO_LIGHT = 1;
const PASSED_ALPHA_BODY_LIGHT = 0.94;
/** 打印前沿（正在打印的那个字素）固定亮度。 */
const PRINT_FRONT_ALPHA = 0.82;
/** 打印前沿之后的 `+0.16` 提前量。 */
const PRINT_LEAD = 0.16;
/** 逐字素辉光：`(GLYPH_GLOW_BASE + fontPx × GLYPH_GLOW_PER_FONT) × eased × boost`。 */
const GLYPH_GLOW_BASE = 2.5;
const GLYPH_GLOW_PER_FONT = 0.1;
/**
 * 起笔那一段航程里，字色从「等待段的暗色」（`pending`）往实心主题色走：
 * `fill = mixColor(pending, hotDeep, SING_DEEP_SPAN × eased)`。
 *
 * 这条曲线是**连续**的（第 4 轮那条结论不变）：`pending` 就是播放头右边那一整段用的**同一支**色，
 * 所以「还没轮到我 → 轮到我」的交界处颜色不跳，只是从这里开始变亮、变实。
 * 走到 45% 交棒给 colour trail（`glyph.endMs` 之后那支 `fumeTrailColor`）。
 */
const SING_DEEP_SPAN = 0.45;
/**
 * **用户 m05660 第 3 条**（图 2）：「当前进度对应的歌词有**高光**和**深色**，然后逐渐褪去颜色」。
 * 正在唱的字素不是直接上主题色，而是往**黑**混 `ACTIVE_DARK_MIX`；辉光仍取**亮**的主题色
 * ⇒ 深色字身 + 亮色光晕。同一行已经唱过的字素从这一档颜色沿 `TRAIL_*` 淡向常态色。
 *
 * **坑（用户 m06899 第 2 条那轮才发现）**：三处调用点原来写的是 `'#000000'`，而 `mixColor` 只认
 * `rgb()` / `rgba()`（`types.ts:308-326`）⇒ 混黑全是 no-op、「深色字身」从 m05660 起就没生效过。
 * 现在统一写成 `'rgb(0, 0, 0)'`。
 *
 * **用户 m00002 第 1 条（第二遍）**：「高亮的字颜色太深、辉光太重，应该如图 1 的样子」——
 * 参考图里高亮那颗字只是**比周围略深一点点**、边上带一圈很淡的光。26% 的混黑在暗底上把高亮压成了
 * 一块沉色，与「唱过之后褪回白」的对比也过强；收到 8%：高亮仍然是「这支主题色的实心字」，
 * 只是比未唱段更实、更重一点点。
 */
const ACTIVE_DARK_MIX = 0.08;
/**
 * **用户 m05660 第 3 条**：正在唱的字素光晕（原来是 `0.5 + eased × 0.5`）。
 * **用户 m00002 第 1 条（第二遍）**：「辉光太重」—— 收到 `0.3 + eased × 0.2`，
 * 配合同步收小的 `GLYPH_GLOW_BASE / GLYPH_GLOW_PER_FONT`，高亮那颗字只剩一圈**很淡**的光。
 */
const GLYPH_GLOW_ALPHA_FLOOR = 0.3;
const GLYPH_GLOW_ALPHA_SPAN = 0.2;
/** passed 亮度。 */
const PASSED_ALPHA_HERO = 0.74;
const PASSED_ALPHA_BODY = 0.58;
/**
 * 整行辉光（原来是 alpha `0.16/0.12 + envelope × 0.26/0.2`）。
 * **用户 m00002 第 1 条（第二遍）**：「辉光太重」—— 整行那一圈几乎是减半（`0.09/0.06 + envelope ×
 * 0.13/0.1`）。它是叠在逐字素辉光之上的一层，两层一起收才不会再糊成一大团光。
 */
const LINE_GLOW_ALPHA_HERO = 0.09;
const LINE_GLOW_ALPHA_BODY = 0.06;
const LINE_GLOW_ALPHA_SPAN_HERO = 0.13;
const LINE_GLOW_ALPHA_SPAN_BODY = 0.1;
const LINE_GLOW_BLUR_HERO = 12;
const LINE_GLOW_BLUR_BODY = 8;
const LINE_GLOW_BLUR_SPAN_HERO = 0.7;
const LINE_GLOW_BLUR_SPAN_BODY = 0.52;
/** 行包络的峰值位置。 */
const LINE_ENVELOPE_PEAK = 0.8;
/**
 * colour trail —— 高亮**左边**那一串已经唱过的字，从热色缓缓退回常态色的时长。
 *
 * **用户 m00002 第 1 条（第二遍）**：「高光左边的渐变褪色太快」—— 上一版把这组时长压到 0.2~0.45s，
 * 结果是高亮左侧只剩一两个字的过渡、再往左全是一片常态色，看起来是「断崖」而不是「渐变」。
 * 现在按行长给（hero 0.5 / body 0.56，句子唱得越久、左侧那道坡铺得越开），上下限放宽到 0.55~1.35s。
 */
const TRAIL_DURATION_MIN = 0.55;
const TRAIL_DURATION_MAX = 1.35;
const TRAIL_RATIO_HERO = 0.5;
const TRAIL_RATIO_BODY = 0.56;
const TRAIL_MIX_FLOOR = 0.28;
const TRAIL_MIX_SPAN = 0.82;
const TRAIL_EXPONENT = 1.35;
/**
 * **用户 m00002 第 1 条（第二遍）**：「歌词渐变褪色到速度随镜头移动速度有所变化」。
 *
 * 镜头此刻在屏幕上每秒走多少像素（直接读 rAF 里弹簧的 `(velocityX, velocityY)`，是跟字位移的真实
 * 速度），除以 `FUME_TRAIL_SPEED_REF` 得到这一帧的**褪色速率倍率**：
 * 镜头走得快 ⇔ 高亮正在飞快往前赶 ⇒ 唱过的那一段也赶紧褪干净（不留一条长尾巴）；
 * 镜头几乎不动 ⇔ 这一句唱得很慢 ⇒ 颜色慢慢地褪。
 *
 * 倍率夹在 `[MIN, MAX]`：`|v|` 在换句 / 过冲时会有尖峰，不夹的话 trail 会被抽成「闪一下」。
 * `FUME_TRAIL_SPEED_SMOOTH` 是一阶低通的速率（每帧向当前速度靠 `dt × 4`），
 * 免得弹簧的瞬时抖动直接变成颜色的一跳一跳。基准 320px/s ≈ 本曲跟字时弹簧的常态速度。
 */
const FUME_TRAIL_SPEED_REF = 320;
const FUME_TRAIL_SPEED_MIN = 0.55;
const FUME_TRAIL_SPEED_MAX = 1.8;
const FUME_TRAIL_SPEED_SMOOTH = 4;
/**
 * **用户 m06899 第 2 条**（图 2）：「像图二一样，左边是渐变褪色，右边是渐变加深」。
 * 右边那道渐变**已被用户本轮第 1 条撤掉**（右边改成恒定中性色），`LEAD_TINT_MS` 随之删除；
 * 这里留一句记号，免得下一轮再把它当成「还没实现」而重新加回来。
 */

/**
 * 等待段（播放头**右边**那一整段）的颜色 = 主题色 `accent` 往**底色**里混的比例。
 *
 * **用户第 5 轮第 1 条**（「右边的歌词部分保持一个暗淡的颜色」）：这支色就是 `FumePaint.pending`
 * —— 与高亮同一支色相，亮度压到「暗」这一档，**满不透明度**铺过去（不再靠透明度分层）。
 * 比例 0.55 是从用户的图 2 反推的：深底上大约把主题色亮度砍一半，对上实测的
 * 「右侧亮度 ≈ 左侧的 0.52、饱和度反而比左侧高（24.5 : 12.8）」。
 *
 * `FumePaint.lead`（`mixColor(accent, 底色, 这个值)`）现在只是**留档**：第 4 轮那道
 * 「越靠近播放头越深」的渐变早撤了，第 5 轮连「中性色」也换成了实体暗色，真实取值在 `pending` 上。
 *
 * 历史依据：图 2 取样——高亮 `rgb(193,215,144)`、等待 `rgb(91,107,83)`、底色 `rgb(40,60,60)`：
 * 等待色正在「主题色与底色之间」，既不是原色也不是满饱和的主题色。
 */
const LEAD_TINT_MIX = 0.55;
/**
 * **用户第 5 轮第 1 条**：等待段那支实体暗色的**对比度地板**（2:1）。
 *
 * 「往底色里混」在深底上会把亮度砍到一半左右（对上目标图量到的「右侧 ≈ 左侧的 0.52」），
 * 若封面底色本身很暗、主题色又不亮，混完会掉到 2:1 以下 —— 那就不叫「暗淡」叫「看不清」。
 * 地板取 2 而不是 `readableColor` 那档 3：高亮那支被保证 ≥3:1，留一级差才能保住「暗一档」的层级
 *（目标图里右侧实测 ≈ 2.2:1，而大字幕在 2:1 下依然读得清）。
 */
const UNPRINTED_MIN_CONTRAST = 2;
/** 相机弹簧。 */
/**
 * 相机把一个「行高」放大到视口短边的百分之几。
 *
 * 这是「镜头里的歌词整体多大」的**唯一旋钮**：世界层里所有块共享同一个相机缩放，所以这个比例
 * 一变，屏上**所有**歌词（高亮句 + 周围那些）跟着同比例放大 / 缩小（不受字号公式影响 ——
 * 字号只决定块与块之间的相对大小）。
 *
 * 历史：0.115（folia 原值）→ 0.105 → 0.09（用户 m00597 那轮「密度太低」把镜头退远一点、
 * 屏上多装几句）。**用户本轮第 1 条**（「取景比例应继续放大到大字幕歌词大小符合图 1 所示」）
 * → **0.14**，比原来的 0.09 大 1.56 倍。量测依据（图 1 逐像素：
 * 大字幕行墨迹高 ≈117px / 窗高 1071 ≈ 10.9%，我们原来是 68px / 965 ≈ 7.0%）：
 * `0.14 × 965 × 0.732 ≈ 99px` 的落点字号 ⇒ 墨迹 ≈ 9~10% 窗高，与图 1 同档。
 */
const CAMERA_LINE_HEIGHT_RATIO = 0.14;
const CAMERA_LINE_HEIGHT_MIN = 64;
/**
 * 目标行高的绝对上限：从 124 抬到 **180**，否则短边 > 1285px 的窗口会被它钉住，
 * 上面那个比例在那类窗口上等于失效（用户本轮第 1 条要的是「按比例整体放大」）。
 */
const CAMERA_LINE_HEIGHT_MAX = 180;
const CAMERA_SCALE_MIN = 0.88;
const CAMERA_SCALE_MAX = 2.2;
const CAMERA_SCALE_HARD_MIN = 0.22;
const CAMERA_SCALE_HARD_MAX = 2.24;
const CAMERA_CATCHUP_STRENGTH = 15.8;
const CAMERA_STRENGTH_MIN = 260;
/**
 * 位置弹簧的强度上限（第十四轮第 3 条起是 780，中途为「跟字」抬到过 2000）。
 *
 * **用户 m00002 第 1 条（第二遍）**：这里曾经把上限抬到 2000 去压「目标按字跳格」带来的滞后 ——
 * 但用户要的是**平滑**（「镜头移动是平滑的，而不是现在这样顿挫的」），硬弹簧只会让顿挫更明显。
 * 真正的解法是让**目标本身连续**（焦点改成打印前沿，见 `resolveFocus`）⇒ 强度回到 780，
 * 跟字档靠 `FUME_FOLLOW_CATCHUP_MS` 定在 ω ≈ 24.8（见下），既不顿挫也跟得住。
 */
const CAMERA_STRENGTH_MAX = 780;
const CAMERA_DAMPING_BASE = 24;
/**
 * 阻尼上限（与 `CAMERA_DAMPING_MAX = 40` 配套时 ζ ≈ 0.68~0.74）。
 * 低强度那一档（root ≈ 16.1）被 `CAMERA_DAMPING_BASE = 24` 托住 ⇒ ζ ≈ 0.74；
 * 跟字那一档（root ≈ 24.8）由 `root × 1.36 ≈ 33.7` 定 ⇒ ζ ≈ 0.68，两档手感一致（都只有一点点过冲）。
 */
const CAMERA_DAMPING_MAX = 40;
const CAMERA_VELOCITY_MIN = 2600;
const CAMERA_VELOCITY_MAX = 8800;
/**
 * **用户 m00002 第 1 条（第二遍）**：跟字跟踪用的弹簧时长（秒）。
 *
 * 弹簧时长只影响 `ω`（见 `cameraSpring`），而**限速**那一项仍按整句时长算 —— 于是「句内跟字」用
 * 一档固定阻尼比的弹簧，「换句飞行」的巡航速度不变（还是那趟慢镜头）。
 * `15.8 / 0.16² ≈ 617` ⇒ `ω = √617 ≈ 24.8`、`ζ ≈ 0.68`：一条**匀滑**的跟随曲线
 *（再硬就回到「顿挫」，再软就跟不住匀速的打印前沿）。
 */
const FUME_FOLLOW_CATCHUP_MS = 160;
const CAMERA_ZOOM_K = 108;
const CAMERA_ZOOM_C = 21;
/**
 * 缩放弹簧换算成二阶系统的自然频率 / 阻尼比（第十四轮第 3 条）：`ω = √k`、`ζ = c / (2ω)`。
 * `springStep` 要的是这两个量；速度倍率只抬 `ω`，`ζ` 不动。由改造前的 `k = 108` / `c = 21`
 * 得 `ω ≈ 10.39` / `ζ ≈ 1.01`（临界阻尼附近），`fumeCameraSpeed = 1` 时与原观感等价。
 */
const CAMERA_ZOOM_OMEGA = Math.sqrt(CAMERA_ZOOM_K);
const CAMERA_ZOOM_ZETA = CAMERA_ZOOM_C / (2 * CAMERA_ZOOM_OMEGA);
/** idle 浮动：18px / 7s / 0.011。 */
const IDLE_DISTANCE = 18;
const IDLE_PERIOD_SEC = 7;
const IDLE_SCALE_AMPLITUDE = 0.011;
/** 初始相机。 */
const INITIAL_CAMERA_SCALE = 1.18;
/** DOM 里保留的块：`[viewIndex - WINDOW_BACK, viewIndex + WINDOW_AHEAD]`。 */
const WINDOW_BACK = 8;
const WINDOW_AHEAD = 12;
/**
 * **用户本轮第 2 条**：按**空间**挂块时的半径（屏幕对角线的倍数）。
 * 0.9 倍对角线 ≈ 屏幕四角再加一点余量 —— 相机移动 / 换句时，块是在屏幕外被挂上 / 摘掉的。
 */
const FUME_VISIBLE_RADIUS = 0.9;
/**
 * 焦点钉在视口**正中**（0.5）。
 *
 * 原来是 0.42（folia 的 fume 相机锚点比例，与 cadenza 同一个值）—— 那时「正在唱的那一句」
 * 会停在窗口偏上的位置，用户看成品图说「镜头中心没跟着高亮的歌词走」（用户 m04987 第 2 条）：
 * 镜头的**取景中心**得压在高亮句上。焦点本来就是激活块的中心（`resolveFocus`），
 * 所以只改这一个锚点比例即可。纵向的纸面覆盖守卫（`CAMERA_EDGE_GUARD`）当时还留着兜底，
 * **用户 m00002 第 1 条**起已经整条拆掉（曲首第一行正是被它钉在窗口顶部、显得没居中）。
 */
const CAMERA_FOCUS_Y = 0.5;
/**
 * 镜头移动速度倍率的兜底区间，与 `LyricTuningSchema.fumeCameraSpeed` 的 `.min(0.4).max(2.5)`
 * 对齐（设置页已经夹过，这里只是热路径上的保险）。`1` = 改造前那组弹簧常数的等效速度。
 */
const FUME_CAMERA_SPEED_MIN = 0.4;
const FUME_CAMERA_SPEED_MAX = 2.5;

/**
 * 相机的平移分量（世界层是 `translate3d(x, y, 0) scale(s)`，`transform-origin: 0 0`，
 * 所以世界点 `w` 的屏幕位置是 `x + w * s`）。
 *
 * **用户 m00002 第 1 条**：「镜头中心要跟着高亮的字移动，**始终**使其位于窗口中心」——所以就一条：
 * 把焦点世界点 `focusWorld` 摆到视口锚点 `anchor` 上，**没有任何夹取**。
 *
 * 拆掉的两条守卫都是为了「整句都别出画」，而它们都会把焦点从画面中心推开 —— 与「始终居中」直接冲突：
 *  · 原来那条「缩放后的纸面必须盖住整个视口」：曲首 / 曲尾把焦点顶回视口边缘（唱第一句时焦点只能
 *    贴纸面上沿），`covered <= viewport` 时更是只按纸面居中 ⇒ 焦点块停在偏上 / 偏左的位置，
 *    正是用户看到的「没在中心」。
 *  · 第十一轮第 1 条（用户 m03279）那条「当前句文字比视口宽时钉住左缘」：句子唱过一半之后，
 *    焦点字离句首的距离就超过半屏，这条下界每帧都生效 ⇒ 高亮的字被钉在右半边、不再居中。
 *    现在跟着高亮走，句首那一截（已经唱过的）本来就会随镜头滑出左边 —— 那是「跟着高亮推进」
 *    的应有之义，不再是「看不到」：正在唱的那颗字永远在窗口正中。
 * 纸面外**没有背景色**（`.pi-lyricfume__world` 透明），越出纸面露出的是沉浸式背景图，不会露白块。
 */
function focusCameraOffset(
  anchor: number,
  focusWorld: number,
  viewport: number,
  scale: number,
): number {
  void viewport;
  return anchor - focusWorld * scale;
}

/**
 * 位置弹簧的 `(ω, ζ)`（第十四轮第 3 条）：把改造前那组常数换算成二阶系统的
 * 自然频率与阻尼比 —— `k = clamp(15.8 / duration², 260, 780)`、`c = clamp(√k × 1.36, 24, 40)`
 * ⇒ `ω = √k`、`ζ = c / (2ω)`。`speed` 是设置页的 `fumeCameraSpeed`，按「等效速度」只抬 `ω`：
 * 二阶系统的快慢由 `ω` 定、`ζ` 只管过冲，所以 `ω' = ω × speed` ⇔ `k' = k × speed²`、`c' = c × speed`。
 * `speed = 1` 时逐位等于改造前（`ζ` 也保持 ≈ 0.68~0.74 那点小过冲）。
 */
function cameraSpring(duration: number, speed: number): { omega: number; zeta: number } {
  const stiffness = clamp(
    CAMERA_CATCHUP_STRENGTH / (duration * duration),
    CAMERA_STRENGTH_MIN,
    CAMERA_STRENGTH_MAX,
  );
  const root = Math.sqrt(stiffness);
  const damping = clamp(root * 1.36, CAMERA_DAMPING_BASE, CAMERA_DAMPING_MAX);
  return { omega: root * speed, zeta: damping / (2 * root) };
}

/**
 * 一步阻尼弹簧积分（第十四轮第 3 条）。
 *
 * 取 Game Programming Gems 系那条**隐式**离散解（隐式欧拉 + 精确求解，Juckett 的 damped springs）：
 *   `f = 1 + 2·dt·ζ·ω`、`det = f + dt²·ω²`、
 *   `x' = (f·x + dt·v + dt²·ω²·target) / det`、`v' = (v + dt·ω²·(target − x)) / det`。
 *
 * 为什么不继续用显式欧拉 `v += ((target − x)·k − v·c)·dt; x += v·dt`：它有稳定性条件
 * （半隐式欧拉约 `ω·dt < 2`）。原来只有 `dt ∈ [1/240, 0.05]` 兜着，`k` 最大 780 ⇒
 * `ω·dt` 最大 ≈ 1.4，已经贴着边界；设置页把速度开到 2.5 时 `k' = k·s²` ⇒ `ω·dt ≈ 3.5`，
 * 特征值 |λ| ≈ 2.25 ⇒ 镜头会自我放大地抖。隐式解对任意 `dt` / `ζ` 都稳定，
 * 所以 `fpsCap` 丢帧（`dt` 变大）或窗口卡顿都不会把相机抖坏，且 60 / 90 / 120 档走同一条轨迹。
 */
function springStep(
  position: number,
  velocity: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): { position: number; velocity: number } {
  const f = 1 + 2 * dt * zeta * omega;
  const omegaSq = omega * omega;
  const hoo = dt * omegaSq;
  const detInv = 1 / (f + dt * hoo);
  return {
    position: (f * position + dt * velocity + hoo * dt * target) * detInv,
    velocity: (velocity + hoo * (target - position)) * detInv,
  };
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeInCubic = (t: number): number => t * t * t;
const mixNumber = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/* ------------------------------------------------------------------ *
 * 文本 / 颜色小工具
 * ------------------------------------------------------------------ */

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemesOf(text: string): string[] {
  if (segmenter === null) return Array.from(text);
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/** 颜色 → `rgba()` 里要用的字符串（`mixColor` 已返回 `rgb(...)`，这里只兜底）。 */
function glowColor(activeColor: string, alpha: number): string {
  return rgba(activeColor, clamp(alpha, 0, 1));
}

/* ------------------------------------------------------------------ *
 * 第十五轮第 4 / 6 条：常态白 + 结尾「缩小铺满」
 * ------------------------------------------------------------------ */

/**
 * 第 4 条：常态（未唱 / 唱过）字色 —— 白。底色撑不住白时由 `readableColor` 降到对比度 3 的墨色。
 *
 * **用户 m00002 第 1 条**：这里必须写 `rgb(...)` 而不是 `#ffffff`。`mixColor` / `parseRgb`
 * 只认 `rgb()` / `rgba()`：hex 喂进去会**原样退回第一个参数**，于是「唱过之后淡回原色」
 * 在暗档会整段 no-op（块色永远停在粉上）。写 rgb() 之后 `ink` 与 `fadeTo` 才是**可混色的**常态色，
 * 暗档 = 白、亮档 = 对比度兜底后的墨色，两种底色都能真的淡过去。
 */
const FUME_INK = 'rgb(255, 255, 255)';

/**
 * **用户第 10 轮第 2 条**（亮底上「已唱过」要近黑）+ **用户第 11 轮第 2 条**（黑度要**和流光一样**）。
 *
 * 现在的正路不是这一支，而是 `ResolvedThemeColors.ink` = 舞台的 `--pi-lyric-ink`
 *（流光 / 云阶 / 倾诉 / 时计在 CSS 里用的同一支：暗档 `#fff`、亮档 `var(--pi-text)` 近黑）。
 * 这里保留的是**兜底**：单测 / 首帧没挂载 / 变量读不出时用它（亮底近黑、暗底白）。
 */
const FUME_INK_LIGHT = 'rgb(15, 15, 15)';

/**
 * **用户 m00002 第 1 条（第二遍）**：暗色模式下「高亮左边那道渐变」的亮度倍率。
 *
 * 用户原话「高光左边的渐变……在暗色模式下太亮了」：暗底上「唱过」的那一段是**纯白**（`fadeTo = ink`），
 * 而纯白永远比一支饱和色更刺眼 —— 高亮左边那半句比高亮本身还亮。压亮度而不是改色相：
 * 落点仍是那个中性常态色（用户上一轮明确要的「褪回原色」，冒烟也拿它与「还没唱到」的白色比色差），
 * 只是把这颗字的**不透明度**随 colour trail 一路降到 `FUME_TRAIL_DIM_DARK`。
 * 亮档 = 1（逐位不变）：亮底上的常态色本来就是对比度兜底后的墨色，不存在「太亮」。
 *
 * **用户第 5 轮第 1 条**（原话：「高亮字左边的歌词部分颜色褪去」）0.85 → **0.78**：
 * 用户这一轮的参考图里，高亮**左边**那半句是**褪了色的**中性色（量前 15% 亮像素 R=168/G=178/B=197，
 * 亮度 ≈ 0.71 白），比第 4 轮那张图里接近满亮的白要收一些 —— 左边要「褪去」、右边（实体暗色）
 * 才是「暗淡」，两档亮度差着约一倍。只降这一点点，是为了保住 m00002 那条
 * 「唱过的字别比高亮那支饱和色更刺眼」，同时守住亮档 = 1（亮底上的常态色本来就是对比度兜底后的墨色）。
 *
 * 亮度层级的现行顺序：**唱过（浅中性白 0.78）> 正在唱（饱和主题色 + 辉光）> 还没到（实体暗色 ≈ 半亮）**。
 */
const FUME_TRAIL_DIM_DARK = 0.78;

/**
 * 第 4 条：一句「唱过」之后，块色与亮度从主题色 / 全亮**逐渐**淡到常态色的时长（其它五套主题共用
 * `--pi-lyric-fade-ms: 900ms`，这里在 rAF 里手算，读不到 CSS 变量）。
 *
 * **用户 m00002 第 1 条（第二遍）**：上一版按「迅速褪色」压到 260ms —— 用户现在说这正是
 * 「高光左边的渐变褪色太快」。回到 900ms：高亮离开后那块**慢慢**淡下去，与逐字素的 colour trail
 * （0.55~1.35s）叠在一起，左边才是「渐变」而不是「断崖」。
 */
const FUME_PASSED_FADE_MS = 900;
/**
 * 「唱过」之后还要接着重绘的时长 = 块级淡出与逐字素 colour trail 里较长的那条。
 * 两者都跑完才允许停止重绘（写死在 `passedFade < 1` 上会让 trail 半路冻住）。
 */
const FUME_PASSED_TRAIL_MS = Math.max(FUME_PASSED_FADE_MS, TRAIL_DURATION_MAX * 1000);
/** 第 6 条：结尾镜头留的边 —— 整张纸按视口的 94% 铺满，别贴死边。 */
const FUME_OUTRO_MARGIN = 0.94;
/** 第 6 条：结尾镜头的缩放下限（极长歌词的兜底，与 `CAMERA_SCALE_HARD_MIN` 同源）。 */
const FUME_OUTRO_SCALE_MIN = 0.16;
/**
 * **用户 m01402 第 3 条**（M4 剩余项之一）：曲尾的提前量。歌词已经唱完、或整首只剩这么多时，
 * 就进结尾镜头 —— 用户要的是「歌曲播放最后几秒」，而歌词常在曲末之前就唱完了。
 */
const FUME_OUTRO_LEAD_MS = 5000;
/**
 * **用户第 6 轮第 1 条**（原话：「浮名的动效下，歌曲结尾展示所有歌词时，有高光的歌词高光要**渐渐散去**
 * 以形成图 1 的效果」）。
 *
 * 结尾镜头里那句原来一直挂着 `palette.accent` + 一圈主题色光晕（第十五轮第 6 条）：整张纸铺满之后
 * 它是画面里**唯一有颜色**的一句。用户给的图 1 里，全曲展示时每一句都是白 / 淡白，没有哪一句还留颜色。
 * 所以进结尾镜头之后让高光**渐散**：`focusFade` 0 → 1，字色从 `accent` 混向 `fadeTo`（常态白）、
 * 光晕同步收掉；**亮度不动** —— 最后唱过的那句仍是整张纸上最亮的一句（图 1 里最亮的那行就是它）。
 *
 * 计时起点 = 这次结尾镜头的起点（唱完时是 `lastEndMs`，没唱完时是 `durationMs − FUME_OUTRO_LEAD_MS`）。
 */
const FUME_OUTRO_FOCUS_FADE_MS = 2600;

/** 结尾镜头高光的渐散进度：0 = 还满着，1 = 已散尽（没进结尾镜头时恒为 0）。 */
export function fumeOutroFocusFade(ms: number, lastEndMs: number, durationMs: number): number {
  const finished = lastEndMs > 0 && ms >= lastEndMs;
  if (!finished && !fumeOutroSoon(ms, lastEndMs, durationMs)) return 0;
  const start = finished ? lastEndMs : Math.max(0, durationMs - FUME_OUTRO_LEAD_MS);
  return clamp((ms - start) / FUME_OUTRO_FOCUS_FADE_MS, 0, 1);
}

/** 第 6 条：结尾镜头的判定结果。 */
export interface FumeOutroPlan {
  /** 歌词是否已经全部唱完（判据见 `fumeOutroPlan`）。 */
  readonly active: boolean;
  /** 整张纸铺满视口所需的缩放（`active` 为 false 时是 1）。 */
  readonly scale: number;
  /** **用户第 6 轮第 1 条**：结尾那句高光的渐散进度（0 = 满、1 = 散尽；未激活时 0）。 */
  readonly focusFade: number;
}

/**
 * 第十五轮第 6 条（用户原话）：「浮名歌词动效，歌曲播放最后几秒歌词已经结束时，缩小画面展示整个
 * 歌词，如图 2 所示。并且镜头要跟随高亮的歌词移动」。
 *
 * **判据**（用户 m01402 第 3 条补上「剩余 N 秒」）：
 *   ① `ms >= lastEndMs`（最后一行的 `endMs` 已经过去）；或
 *   ② 知道整首时长且 `durationMs - ms <= FUME_OUTRO_LEAD_MS` —— 歌词写完之后还有一段纯音乐时，
 *      只靠 ① 要等到曲末才进镜头，用户要的「最后几秒」就落不到。
 * 两条都判不了（`lastEndMs <= 0` 且 `durationMs <= 0`）时恒不激活，不传时长的老调用点行为一字不改。
 * **缩放值**：`scale = min(视口宽 / 纸宽, 视口高 / 纸高) × 0.94`，再夹到 `[0.16, 1]`：
 * 两个方向里先贴满的那一边正好铺满视口（「铺满全屏」），另一边居中留边，整首歌词一个字都不切。
 */
export function fumeOutroPlan(
  ms: number,
  lastEndMs: number,
  paperWidth: number,
  paperHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  durationMs = 0,
): FumeOutroPlan {
  const finished = lastEndMs > 0 && ms >= lastEndMs;
  if (!finished && !fumeOutroSoon(ms, lastEndMs, durationMs)) {
    return { active: false, scale: 1, focusFade: 0 };
  }
  const fit = Math.min(
    viewportWidth / Math.max(paperWidth, 1),
    viewportHeight / Math.max(paperHeight, 1),
  );
  return {
    active: true,
    scale: clamp(fit * FUME_OUTRO_MARGIN, FUME_OUTRO_SCALE_MIN, 1),
    focusFade: fumeOutroFocusFade(ms, lastEndMs, durationMs),
  };
}

/**
 * 「歌词**还没**唱完，但整首只剩 `FUME_OUTRO_LEAD_MS` 以内」——`data-fume-state='outro-soon'`
 * 用的就是它（纯函数，另有单测）。不知道时长、`ms` 越过曲长、或歌词已经唱完时返回 false，
 * 这样「唱完」与「快到点」在 DOM 上是两个可分辨的态。
 */
export function fumeOutroSoon(ms: number, lastEndMs: number, durationMs: number): boolean {
  if (!(durationMs > 0) || ms > durationMs) return false;
  if (lastEndMs > 0 && ms >= lastEndMs) return false;
  return durationMs - ms <= FUME_OUTRO_LEAD_MS;
}

/**
 * 结尾镜头的位移：把 `focusWorld` 推到视口中心，但**整张纸不许出画**（这就是用户要的
 * 「镜头要跟随高亮的歌词移动」——跟随被夹在「整首歌词始终可见」的区间里，所以既跟了又不切）。
 * 纸完全可见时允许的位移区间是 `[0, 视口 − 纸 × scale]`（区间本来就很小 ⇒ 观感接近居中）；
 * 纸比视口还大时反过来是 `[视口 − 纸 × scale, 0]`（必须盖住视口）。两种情况一条式子写完。
 */
export function fumeOutroOffset(
  focusWorld: number,
  paperSize: number,
  viewportSize: number,
  scale: number,
): number {
  const free = viewportSize - paperSize * scale;
  const follow = viewportSize * 0.5 - focusWorld * scale;
  return clamp(follow, Math.min(0, free), Math.max(0, free));
}

/**
 * 底色亮到多少算「亮底」。
 *
 * 与 `ensureContrast` 内部那条判据**同源同值**（`types.ts:639` 的 `relativeLuminance(bg) > 0.42`
 * ⇒ 亮底、前景往黑推），所以「暗档」与「对比度兜底的方向」永远一致。两档之间隔了两个数量级，
 * 不会误判：`cover-palette.ts` 的暗底 `BACKGROUND_TONES` 亮度 ≈ 0.006~0.02（l ∈ [0.055, 0.14]），
 * 亮底 ≈ 0.78~0.92（l ∈ [0.9, 0.965]）；中性兜底暗 `#101418` ≈ 0.007 / 亮 `#f2f5fa` ≈ 0.90。
 */
const DARK_SURFACE_LUMINANCE = 0.42;

/** 底色是不是暗底。拿不到底色（`var()` 没解析出来 / 单测里没有 DOM）时算亮底 ⇒ 整套颜色等于改造前。 */
function isDarkSurface(surface: RgbColor | null): boolean {
  return surface !== null && relativeLuminance(surface) < DARK_SURFACE_LUMINANCE;
}

/** 这一帧要用的颜色（已解析成 `rgb()` / 已过对比度兜底）。 */
export interface FumePaint {
  readonly primary: string;
  readonly accent: string;
  /** 第十五轮第 4 条：常态（未唱 / 唱过）字色 = 白（底色撑不住白时降到可读墨色）。 */
  readonly ink: string;
  /**
   * **用户本轮第 2 条**（图）：**还没唱到**的那些块用的原色浅档 —— `ink` 往底色里混
   * `WAIT_TINT_MIX`。「已经唱过」用 `ink`（深档）、「还没唱到」用这一支（浅档）：
   * 两支同色系、只差深浅，所以纸上能一眼分出「唱过的 / 等着唱的」。
   */
  readonly waitInk: string;
  /**
   * **用户 m00001 + 本轮第 1 条**：当前句（相位 `active`）的「热色」—— 正在唱的那一颗字高亮成它。
   *
   * **两种底色都取 `accent`**（封面推出来的那支鲜艳色）。不能取 `primary` 的原因亮暗各一条：
   *  · 暗底：`deriveThemeColors` 把 primary 推到 `PRIMARY_LIGHTNESS_DARK = 0.94` + 低饱和
   *    （`lib/cover-palette.ts:581-589`）⇒ 高亮色 ≈ 白，与常态白撞成一片（m00001 原话「不应该高亮成原色」）；
   *  · 亮底：primary 反过来被压成**近黑**（实测 `rgb(44,37,28)`，与常态墨色 `rgb(26,29,36)` 几乎一样）
   *    ⇒ 高亮那颗、以及等待段的近端**看起来就是常态原色**——正是本轮图 1 里「右边有一部分是原色的」。
   * `accent` 走 `ACCENT_LIGHTNESS_DARK / LIGHT` + 高饱和（`:590-598`），才是封面那支鲜艳色 ——
   * 与 classic 主题 `--pi-lyric-hot` 的取法（`styles/lyric-stage.css:131`）一致。
   */
  readonly hot: string;
  /**
   * **用户第 5 轮第 1 条**：当前句「进度还没到」那一整段的颜色 = 「唱到它」那一刻的**起笔色**。
   *
   * = `mixColor(accent, 底色, LEAD_TINT_MIX)` —— 主题色的**暗档**，满不透明度铺过去
   *（用户原话「右边……保持一个暗淡的颜色」）。两边共用同一支色，所以播放头扫过时那颗字是
   * 从这里**连续地**变亮、变实（`SING_DEEP_SPAN`），交界处没有跳变。
   */
  readonly pending: string;
  /**
   * **留档**（第 5 轮起没有消费者）：第 4 轮那道「等待段越靠近播放头越深」的**远端色**
   *（`accent` 往底色里混 `LEAD_TINT_MIX`）。它记录了 m06899 那轮「浅色 = 主题色往底色里混」的结论；
   * 那道渐变第 4 轮就撤了（改中性色），第 5 轮再改成实体暗色，真实取值一律在 `pending` 上。
   */
  readonly lead: string;
  /**
   * 「唱过」之后逐块 / 逐字素淡出的**终点色** = 常态色（**用户 m00002 第 1 条**：褪到原色，白 / 黑）。
   *
   * 两种底色都用 `ink`：
   *  · 亮档本来就是 `ink`（逐位等于改造前，上一轮已认可的亮色观感不动）；
   *  · 暗档以前传的是 `primary`（封面主色）—— 那是 `mixColor` 认不了 hex `#ffffff` 时的**绕道**，
   *    代价是「唱过」的那句停在封面主色上（实测本曲是 `#6591e1` 那支蓝），与**还没唱到**的常态白
   *    南辕北辙，用户看到的就是「高亮离开了却没回原色」。`FUME_INK` 改成 `rgb()` 之后这个绕道不需要了，
   *    暗档也走 `ink` ⇒ 粉 → 白是真的渐变，唱过的每一句都回到与未唱句同一个常态色。
   */
  readonly fadeTo: string;
  /**
   * **用户 m00002 第 1 条（第二遍）**：暗底上「已经唱过」那一段的**亮度倍率**（亮档 = 1）。
   *
   * 用户原话「高光左边的渐变……在暗色模式下太亮了」—— 暗底上那段是纯白（`fadeTo = ink`），
   * 比高亮那支饱和色更刺眼。压的是**不透明度**（`paintActiveGlyphs` 里随 colour trail 的 `p`
   * 把字素透明度乘到 `passedDim`），不是色相：落点仍是那个中性常态色 —— 用户上一轮要的
   * 「褪回原色」、以及冒烟里那条「唱过的字与还没唱到的字同色」的判据都继续成立。
   */
  readonly passedDim: number;
  /** 底色（拿不到就是 null：不做对比度调整，颜色照用）。 */
  readonly surface: RgbColor | null;
  /*
   * **用户（本轮）第 3 条**：四档不透明度改成**按底色明暗分开**给（此前是模块常量、两种底色一套值）。
   *
   * 原话：「在浅色模式下……深色的是已经唱过的歌词，浅色的是未唱的歌词。图 6 是我们 app 的显示，
   * 明显深浅不明显，深的太浅，浅的太深」。暗底上那套（未唱 0.18/0.12、唱过 0.74/0.58）在**亮底**
   * 上正好把两档拉到一起：已唱不够实、未唱又太沉。所以亮底单独一套（更实 / 更淡，见
   * `WAIT_ALPHA_*_LIGHT` / `PASSED_ALPHA_*_LIGHT`），暗底逐位沿用原值。
   */
  readonly waitAlphaHero: number;
  readonly waitAlphaBody: number;
  readonly passedAlphaHero: number;
  readonly passedAlphaBody: number;
}

/** palette 色 → 可直接写进 DOM 的字符串：解析得出就按底色调对比度，解析不出就用原值。 */
function readableColor(value: string, surface: RgbColor | null): string {
  if (surface === null) return value;
  const parsed = parseRgb(value);
  if (parsed === null) return value;
  return ensureContrast(parsed, surface, 3);
}

export function buildFumePaint(colors: ResolvedThemeColors): FumePaint {
  const surface = parseRgb(colors.surface);
  const primary = readableColor(colors.primary, surface);
  const accent = readableColor(colors.accent, surface);
  const dark = isDarkSurface(surface);
  /*
   * 常态（未唱 / 唱过）字色（**用户第 11 轮第 2 条**）：
   *
   * 直接吃 `ResolvedThemeColors.ink` —— 那就是 classic / partita / tilt / pendolo 在 CSS 里用的
   * `--pi-lyric-ink`（暗档 `#fff`、亮档 `var(--pi-text)` 近黑），所以「浮名浅色模式下唱过的歌词
   * 应该和流光的黑色一样」这一条是**结构上成立**的，不再靠各自调数。
   *
   * 历史（为什么现在才这样）：第 10 轮按主人的图把亮档改成「就是要近黑 rgb(15,15,15)」——
   * 方向对了、但它是**独立的一支**，与流光的 `--pi-text` 并不逐位相同（主人第 11 轮第 2 条
   * 指出的正是这点：「没那么深，应该和流光的黑色一样」）。
   *
   * 兜底：拿不到 `ink`（单测 / 首帧没挂载 / 变量读不出）时退回「亮底近黑 / 暗底白」的老口径。
   */
  const inkRaw = typeof colors.ink === 'string' && colors.ink.trim() !== '' ? colors.ink : '';
  const inkRgb = parseRgb(inkRaw) ?? parseRgb(dark ? FUME_INK : FUME_INK_LIGHT);
  const ink =
    inkRaw === '' || inkRgb === null
      ? dark
        ? FUME_INK
        : FUME_INK_LIGHT
      : `rgb(${Math.round(inkRgb.r)}, ${Math.round(inkRgb.g)}, ${Math.round(inkRgb.b)})`;
  /*
   * **用户本轮第 1 条**：等待段的「浅色」= 主题色**往底色里混**。
   *
   * 拿得到底色串（`--pi-th-surface` 解析成功）就用它；拿不到（单测 / 首帧变量还没注入）退回
   * 改造前的口径：暗档混近白的 `primary`、亮档混 `rgb()` 纯白 —— 这里必须写 `rgb()`，
   * 写 hex 会让 `mixColor` 整段 no-op（它只认 `rgb()` / `rgba()`）。
   */
  const leadBlend =
    surface === null
      ? dark
        ? primary
        : 'rgb(255, 255, 255)'
      : `rgb(${surface.r}, ${surface.g}, ${surface.b})`;
  const lead = mixColor(accent, leadBlend, LEAD_TINT_MIX);
  // **用户本轮第 2 条**：还没唱到的那档原色 = `ink` 往同一支底色里混（深档留给「已经唱过」）。
  // **用户（本轮）第 3 条**：亮底混得更多（0.45 → 0.66），把「未唱」压成纸色。
  const waitInk = mixColor(ink, leadBlend, dark ? WAIT_TINT_MIX : WAIT_TINT_MIX_LIGHT);
  /*
   * **用户第 5 轮第 1 条**：播放头右边那一整段的**实体暗色**（= `pending`，见它在 `FumePaint` 的注释）。
   *
   * 「往底色里混」在暗底上是**变暗**、在亮底上是**变淡**，两个方向都是「对比度低于高亮那颗字」——
   * 这正是用户要的「暗淡」。再兜一道 `UNPRINTED_MIN_CONTRAST`（2:1）的地板：混过头时把它拉回能读的
   * 程度（大字幕在 2:1 下仍读得清；高亮那支被 `readableColor` 保证 ≥3:1 ⇒ 兜底不会把两档拉平）。
   * 拿不到底色（单测 / 首帧变量还没注入）时不兜：没有底色就没有对比度可算。
   */
  const unprintedRaw = mixColor(accent, leadBlend, LEAD_TINT_MIX);
  const unprintedRgb = parseRgb(unprintedRaw);
  const pending =
    unprintedRgb === null || surface === null
      ? unprintedRaw
      : ensureContrast(unprintedRgb, surface, UNPRINTED_MIN_CONTRAST);
  return {
    primary,
    accent,
    ink,
    waitInk,
    // **用户本轮第 1 条**：高亮色两种底色都取 `accent` —— 亮档不再拿近黑的 `primary`
    //（那正是图 1 里「右边有一段看起来是原色」的根因，见 `hot` 的注释）。
    hot: accent,
    // 等待段的**整段**颜色 = 起笔色：`pending` 同时是「播放头右边」与「刚起笔」的那一支暗色，
    // 所以交界处不跳（见 `SING_DEEP_SPAN`）。
    pending,
    lead,
    // **用户 m00002 第 1 条**：唱过的终点 = 常态色（`ink`）。暗档不再绕道 `primary`（见 `fadeTo` 注释）。
    fadeTo: ink,
    // **用户 m00002 第 1 条（第二遍）**：只有暗底才把「唱过」那段压暗（亮底的常态色是墨色，不亮）。
    passedDim: dark ? FUME_TRAIL_DIM_DARK : 1,
    surface,
    // **用户（本轮）第 3 条**：四档不透明度按底色明暗分开（亮底 = 更实 / 更淡）。
    waitAlphaHero: dark ? WAIT_ALPHA_HERO : WAIT_ALPHA_HERO_LIGHT,
    waitAlphaBody: dark ? WAIT_ALPHA_BODY : WAIT_ALPHA_BODY_LIGHT,
    passedAlphaHero: dark ? PASSED_ALPHA_HERO : PASSED_ALPHA_HERO_LIGHT,
    passedAlphaBody: dark ? PASSED_ALPHA_BODY : PASSED_ALPHA_BODY_LIGHT,
  };
}

/* ------------------------------------------------------------------ *
 * 排版求解
 * ------------------------------------------------------------------ */

interface FumeGlyph {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface FumeWordClump {
  readonly wordIndex: number;
  readonly color: string;
  readonly glyphs: readonly FumeGlyph[];
}

interface FumeBlock {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  /** 字重（hero 780 / body 640）：canvas 度量必须和 DOM 一致，所以随块一起存下来。 */
  readonly weight: number;
  readonly fontPx: number;
  readonly lineHeightPx: number;
  /** **用户第 9 轮第 1 条**之后是「起始**细槽**号」（不再是四栏里的栏号）。 */
  readonly column: number;
  /** 占几个细槽（盒子宽 + 净空换算出来的）。 */
  readonly span: number;
  readonly x: number;
  readonly y: number;
  /** 盒子宽 = `min(栏宽 / 跨栏宽, 文字自然宽)`（**用户第 9 轮第 1 条**）。 */
  readonly width: number;
  readonly height: number;
  readonly words: readonly FumeWordClump[];
  /** 这一块里第一个字素的绝对时间（做逐字素打印的 fallback）。 */
  readonly startMs: number;
  readonly endMs: number;
  readonly lineDurationMs: number;
  readonly translated?: string;
}

interface FumePlan {
  readonly paperWidth: number;
  readonly paperHeight: number;
  readonly blocks: readonly FumeBlock[];
  /** 内容（歌词块）在纸面坐标系里的左上角。第十一轮第 1 条：相机靠它避免切掉左边的字。 */
  readonly contentLeft: number;
  readonly contentTop: number;
}

/** 把一个词的时间区间按字素数均分给每个字素（与 `LyricStage.buildStageLines` 同款近似）。 */
function wordGlyphs(text: string, startMs: number, endMs: number): FumeGlyph[] {
  const parts = graphemesOf(text);
  const count = Math.max(parts.length, 1);
  const step = (endMs - startMs) / count;
  const out: FumeGlyph[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const start = startMs + step * index;
    out.push({ text: parts[index] ?? '', startMs: start, endMs: start + step });
  }
  return out;
}

function buildFumeColours(
  line: StageLine,
  palette: LyricPalette,
): readonly { color: string; glyphs: readonly FumeGlyph[] }[] {
  const starts = line.starts;
  const ends = line.ends;
  const wordCount = Math.max(starts.length, line.words.length);
  const out: { color: string; glyphs: readonly FumeGlyph[] }[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    const word = line.words[index];
    const text = word?.text ?? '';
    if (text === '') continue;
    const startMs = starts[index] ?? word?.startMs ?? line.timeMs;
    const endMs = ends[index] ?? word?.endMs ?? line.timeMs + line.durationMs;
    out.push({
      color: wordColorOf(palette, text, palette.accentColor),
      glyphs: wordGlyphs(text, startMs, endMs),
    });
  }
  return out;
}

/**
 * 量一块文字会折成几行。
 *
 * 用 `measureTextWidth()`（canvas `measureText`，字体栈 / 字重和 DOM 完全一致）而不是
 * 「CJK 每字 1em、其余 0.55em」的估算：估算在拉丁 / 西里尔 / 假名混排下会低估宽度，
 * 折行数偏小 → 块高偏小 → 打乱的块会**互相压住**。
 * 词间空格只在「用空格分词」的语言里加（CJK / 假名 / 泰文没有词间空格）。
 */
function estimateRowCount(
  words: readonly FumeWordClump[],
  availableWidth: number,
  fontPx: number,
  weight: number,
  fontFamily: string,
): number {
  let width = 0;
  for (const word of words) {
    const text = word.glyphs.map((glyph) => glyph.text).join('');
    if (text === '') continue;
    width +=
      measureTextWidth(text, fontPx, weight, fontFamily, 0) +
      (usesWordSpaces(text) ? fontPx * 0.12 : 0);
  }
  return Math.max(1, Math.ceil(width / Math.max(availableWidth, 1)));
}

/** hero 判定的确定性种子（全局回退用；固定值保证同一行每次渲染都被选中 / 不被选中）。 */
const HERO_SEED = 13.7;

/** 一级：自然 hero —— 副歌短句，或「靠中间 + 中等长度 + 每 6 行一次 / 随机命中」的长句。 */
function isNaturalHero(lines: readonly StageLine[], line: StageLine, graphemes: number): boolean {
  if (isChorusLine(lines, line.index) && graphemes <= 22) return true;
  if (graphemes < 4 || graphemes > 28) return false;
  const total = Math.max(lines.length, 1);
  if (Math.abs(line.index - total / 2) / total >= 0.72) return false;
  return (line.index + 1) % 6 === 0 || seededFraction(HERO_SEED + line.index) > 0.965;
}

/**
 * 二级：全局回退 —— 整首一个自然 hero 都没有时，按
 * `centerScore × 0.62 + lengthScore × 0.34 + chorusScore + seededFraction(seed) × 0.04`
 * 选出**恰好一个** hero（种子确定，同一份歌词每次渲染选中的都是同一行）；
 * 再不行退回最短的非空块。
 */
function pickGlobalHero(
  candidates: readonly { readonly line: StageLine; readonly graphemes: number }[],
  lines: readonly StageLine[],
): number {
  const total = Math.max(lines.length, 1);
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const { line, graphemes } = candidate;
    const centerScore = 1 - Math.abs(line.index - total / 2) / total;
    const lengthScore = graphemes >= 6 && graphemes <= 22 ? 1 : graphemes <= 28 ? 0.72 : 0.36;
    const chorusScore = isChorusLine(lines, line.index) ? 1 : 0;
    const score =
      centerScore * 0.62 +
      lengthScore * 0.34 +
      chorusScore +
      seededFraction(HERO_SEED + line.index) * 0.04;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  if (best >= 0) return best;
  let shortest = -1;
  let shortestLength = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    if (candidate.graphemes < shortestLength) {
      shortestLength = candidate.graphemes;
      shortest = index;
    }
  }
  return shortest;
}

/**
 * **用户本轮第 3 条**（原话：「大字幕歌词占比要比普通的少一些」）：大字幕块最多占候选块的 **1/3**
 * ⇒ 普通块 : 大字幕块 ≳ **2 : 1**，大字幕是少数、普通句是版面的主体。
 *
 * 为什么需要这一条：`isNaturalHero` 会把**每一句副歌**都判成 hero（判据是「同一句在整首歌里出现
 * 两次以上」，见 `types.ts` 的 `isChorusLine`），再加上「每 6 行一次」那支点缀，副歌密集的歌里
 * 大字幕能到四成以上 —— 屏上就变成「一屏全是大字」。参考图的观感是**少数大字 + 多数普通字**。
 * 1/3 是「明显是少数、又不至于一屏看不到一个大字」的档位。
 */
const FUME_HERO_MAX_RATIO = 1 / 3;

/**
 * 把「自然 hero」裁到 `maxRatio` 以内（**纯函数**，用户本轮第 3 条）。
 *
 * 两趟摘：先摘**非副歌**的候选（从后往前），还超再摘**副歌**的（也从后往前）——
 * 被摘掉的是「最靠后、离副歌最远」的那些，留下来的骨架仍是「副歌优先 + 靠前优先」，
 * 且完全确定性（同一份歌词每次得到同一组 flags）。
 *
 * `cap` 至少为 1：一首歌只要有一行被判成 hero，就不该被裁成「一个大字都没有」
 * （真的一行都没有时走 `pickGlobalHero` 的全局回退，那条路不经过这里）。
 */
export function capFumeHeroes(
  natural: readonly boolean[],
  chorus: readonly boolean[],
  maxRatio: number,
): boolean[] {
  const flags = [...natural];
  const total = flags.length;
  if (total === 0) return flags;
  const cap = Math.max(1, Math.floor(total * maxRatio));
  let count = flags.filter((flag) => flag).length;
  if (count <= cap) return flags;
  for (const chorusPass of [false, true]) {
    for (let index = total - 1; index >= 0 && count > cap; index -= 1) {
      if (flags[index] !== true) continue;
      if ((chorus[index] === true) !== chorusPass) continue;
      flags[index] = false;
      count -= 1;
    }
  }
  return flags;
}

/**
 * 「细槽」落位（**用户第 9 轮第 1 条**）。纯函数，`FumeTheme.test.ts` 逐条钉不变量。
 *
 * 老口径是四根柱子：`x = column × (columnWidth + gap)`，块不管多短都占满整栏，
 * 于是短句右侧那 2/3 栏成了**谁也进不来的死空白**（主人图里那道竖向空白就是四栏叠出来的）。
 *
 * 新口径把纸面切成细槽（`slotPx`），每块只按**自己的真实宽 + 一道净空**占槽：
 *  - 落点 = 「覆盖的槽里最大高度最小」的那个起始槽（与老口径同一个启发式，只是柱子细了几十倍）；
 *  - 高度表按槽更新 ⇒ 相邻两块只要高度允许就贴在一起（净空 = `gutter`）；
 *  - 纸面放不下就整体往下再铺一张纸（`page`），与老口径一致。
 *
 * 不变量（测试逐条钉）：
 * ① 任意两块**不重叠**（新块只落在「覆盖槽的上沿」之下）；
 * ② 同一行相邻两块之间至少留出 `gutter`（块宽 < 占槽宽，槽宽已包含净空）；
 * ③ 同一个输入两次结果**逐位相同**（没有随机数）；
 * ④ 每块的**槽浪费 ≤ slotPx**（盒子不再按栏宽占地 ⇒ 那道空白消失）。
 */
export interface FumePackItem {
  readonly width: number;
  readonly height: number;
  /** 块前空隙（世界 px）。老口径里是 `BLOCK_GAP_*`（用户本轮第 3 条之后恒为 0）。 */
  readonly gapBefore: number;
}

export interface FumePackSlot {
  readonly x: number;
  readonly y: number;
  /** 起始槽号。 */
  readonly slot: number;
  /** 占几个槽。 */
  readonly span: number;
  /** 第几张纸（0 起）。 */
  readonly page: number;
}

export function packFumeSlots(
  items: readonly FumePackItem[],
  options: {
    readonly paperWidth: number;
    readonly paperHeight: number;
    readonly slotPx: number;
    readonly gutter: number;
    readonly pageGapPx: number;
  },
): FumePackSlot[] {
  const { paperWidth, paperHeight, slotPx, gutter, pageGapPx } = options;
  const slotCount = Math.max(1, Math.floor(paperWidth / slotPx));
  const cursors = new Array<number>(slotCount).fill(0);
  const out: FumePackSlot[] = [];
  let page = 0;
  let pageOffset = 0;
  for (const item of items) {
    const span = Math.min(slotCount, Math.max(1, Math.ceil((item.width + gutter) / slotPx)));
    let bestSlot = 0;
    let bestHeight = Number.POSITIVE_INFINITY;
    for (let start = 0; start + span <= slotCount; start += 1) {
      let maxHeight = 0;
      for (let offset = 0; offset < span; offset += 1) {
        maxHeight = Math.max(maxHeight, cursors[start + offset] ?? 0);
      }
      if (maxHeight < bestHeight) {
        bestHeight = maxHeight;
        bestSlot = start;
      }
    }
    let top = Number.isFinite(bestHeight) ? bestHeight : 0;
    if (top + item.gapBefore + item.height > paperHeight) {
      page += 1;
      pageOffset += paperHeight + pageGapPx;
      for (let index = 0; index < slotCount; index += 1) cursors[index] = 0;
      top = 0;
    }
    const y = top + item.gapBefore;
    const bottom = y + item.height;
    for (let offset = 0; offset < span; offset += 1) cursors[bestSlot + offset] = bottom;
    out.push({ x: bestSlot * slotPx, y: y + pageOffset, slot: bestSlot, span, page });
  }
  return out;
}

function buildFumePlan(
  lines: readonly StageLine[],
  translated: ReadonlyMap<number, string>,
  viewportWidth: number,
  viewportHeight: number,
  palette: LyricPalette,
  fontFamily: string,
): FumePlan {
  // 这套主题只有字号吃设置：构图 / 分栏 / 打乱都按「纸面」算，动字号会连带纸面重排，
  // 所以必须在 buildFumePlan 里乘，而不是渲染时改 CSS（那样只会把字挤出自己那一格）。
  const { fontScale } = tuningOf(palette);
  const paperWidth = clamp(
    Math.max(viewportWidth * PAPER_WIDTH_VW, viewportWidth + PAPER_WIDTH_EXTRA),
    PAPER_WIDTH_MIN,
    PAPER_WIDTH_MAX,
  );
  const paperHeight = Math.max(viewportHeight, PAPER_HEIGHT_FLOOR) * PAPER_HEIGHT_MULT;
  const cols = paperWidth >= 1120 ? 4 : paperWidth >= 760 ? 3 : paperWidth >= 500 ? 2 : 1;
  const gap = clamp(
    Math.round(paperWidth * (cols >= 4 ? GAP_RATIO_4 : cols === 3 ? GAP_RATIO_3 : GAP_RATIO_2)),
    GAP_MIN,
    GAP_MAX,
  );
  const columnWidth = (paperWidth - gap * (cols - 1)) / cols;

  // 1. 先切字素（hero 判定只依赖字素数 / 词数 / 是否副歌，与几何无关）。
  interface Candidate {
    readonly line: StageLine;
    readonly graphemes: number;
    readonly words: readonly FumeWordClump[];
  }
  const candidates: Candidate[] = [];
  for (const line of lines) {
    const clumps = buildFumeColours(line, palette);
    let graphemes = 0;
    for (const clump of clumps) graphemes += clump.glyphs.length;
    if (graphemes === 0) continue;
    candidates.push({
      line,
      graphemes,
      words: clumps.map((clump, wordIndex) => ({
        wordIndex,
        color: clump.color,
        glyphs: clump.glyphs,
      })),
    });
  }
  if (candidates.length === 0) {
    return {
      paperWidth,
      paperHeight,
      blocks: [],
      contentLeft: paperWidth * 0.5,
      contentTop: paperHeight * 0.5,
    };
  }

  // 2. hero 判定：自然 hero → **按占比裁一次**（用户本轮第 3 条：大字幕要比普通少）→
  //    一个都没有时走全局回退（最多一个 hero）。
  const naturalHero = candidates.map((candidate) =>
    isNaturalHero(lines, candidate.line, candidate.graphemes),
  );
  const heroFlags = capFumeHeroes(
    naturalHero,
    candidates.map((candidate) => isChorusLine(lines, candidate.line.index)),
    FUME_HERO_MAX_RATIO,
  );
  if (!heroFlags.some((flag) => flag)) {
    const fallback = pickGlobalHero(candidates, lines);
    if (fallback >= 0) heroFlags[fallback] = true;
  }

  // 3. 块宽 / 字号 / 折行估算（现在 hero 已知，几何才对得上）。
  interface Sized {
    readonly line: StageLine;
    readonly hero: boolean;
    /**
     * 落位用的**盒子宽**。**用户第 9 轮第 1 条**之后它是
     * `min(栏宽 / 跨栏宽, 文字自然宽 × 1.02 + 2)` —— 不再是「一整栏」：
     * 短句的盒子贴着字，右侧那块地交还给后面的块（这才是「让两片歌词挨在一起」）。
     */
    readonly width: number;
    /** 文字单行不折行时的自然宽，只用于上面那次取小与冒烟记录。 */
    readonly naturalWidth: number;
    readonly weight: number;
    readonly fontPx: number;
    readonly lineHeightPx: number;
    readonly height: number;
    readonly words: readonly FumeWordClump[];
  }
  const sized: Sized[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const { line, graphemes, words } = candidate;
    const hero = heroFlags[index] === true;
    const wordCount = words.length;
    const density = graphemes + wordCount * 1.4;
    /**
     * **这一块最多能占多宽**（hero 跨栏 / 正文一栏）。字号仍按这个「hero 口径」取基准 ——
     * 正文块只占一栏时若拿自己那一栏的宽度套 hero 公式，得到的是 hero 的**一半**，
     * 那是宽度差，不是「正文比高亮句小一档」（要的正是后者，见 `FUME_BODY_TO_HERO`）。
     *
     * **用户第 9 轮第 1 条**之后它不再等于盒子的实际宽度（`width` 见下）：
     * 字号口径一个字节没动，动的只是**块占多大地方**。
     */
    const heroWidth =
      cols > 2 ? columnWidth * 2 + gap : cols === 2 ? columnWidth * 1.5 + gap * 0.5 : paperWidth;
    const maxBox = hero ? heroWidth : columnWidth;
    /**
     * 字号 = 原公式（hero 口径）× 设置里的 `fontScale`。
     *
     * 「hero 口径」= 拿 `heroWidth` 与这一行自己的密度代入 folia 那条公式，再夹 `[24, 54]`：
     *  · hero 块：逐位等于改造前（它就是拿自己的跨栏宽算的）；
     *  · 正文块：在这个基准上乘 `FUME_BODY_TO_HERO`（= 0.9）⇒ 屏上正文 ≈ 高亮句的 0.9 倍
     *    （**用户本轮第 1 条**：图里那几行字几乎一样大、只差深浅）。旧的正文公式
     *    （`宽 / max(√密度 × 2.25, 7)`、夹 `[14, 28]`）整支撤掉。
     * 中间那层 clamp 的上下限仍跟着 `fontScale` 放宽同样倍数，最后再按 `FONT_SCALE_MAX` 夹一次，
     * 保证 1.3 倍时也不会把一行字撑出它所在的栏（超长的单个词本来就换不了行，这里只能保证
     * 不比原来更容易撞）。
     */
    const fontPx = fumeFontPx(hero, heroWidth, density, fontScale);
    const lineHeightPx = fontPx * (hero ? 1.02 : 1.06);
    const weight = hero ? 780 : 640;
    /*
     * **用户第 9 轮第 1 条**：盒子缩到**文字的自然宽**。
     *
     * 留一点余量（×1.02 + 2px）：canvas 量宽与浏览器真实排版之间有亚像素差，
     * 盒子刚好等于墨迹宽时，「本来一行」的句子会被 `estimateRowCount` 与 DOM 判成两行
     * （那就从「挨在一起」变成了「自己叠起来」）。
     *
     * 自然宽本来就超过栏宽的长句 ⇒ 盒子仍是栏宽，折行行为与改造前**逐位相同**。
     */
    const naturalWidth = measureTextWidth(line.text, fontPx, weight, fontFamily, 0);
    const fitsOneRow = naturalWidth <= maxBox;
    const width = fitsOneRow ? naturalWidth * 1.02 + 2 : maxBox;
    /*
     * 行数：**装得下就一定是 1 行**（盒子是自己量出来的自然宽，DOM 里必然排成一行），
     * 装不下才走贪心折行估算。为什么明写这一支：`estimateRowCount` 给每个用空格分词的语言的词
     * 多加 0.12em，拉丁行的估算和「盒子刚好等于墨迹宽」这件事会打架 —— 估算说 2 行、DOM 排 1 行，
     * 于是块**多占一行高度**（纸面上多出一块看不见的空白，正是这一轮要消掉的东西）。
     */
    const rows = fitsOneRow ? 1 : estimateRowCount(words, width, fontPx, weight, fontFamily);
    const height = rows * lineHeightPx * BLOCK_ROW_PITCH + lineHeightPx * BLOCK_TAIL_RATIO;
    const block: Sized = {
      line,
      hero,
      width,
      naturalWidth,
      weight,
      fontPx,
      lineHeightPx,
      height,
      words,
    };
    sized.push(block);
  }

  // 4. 确定性打乱（fume 的灵魂：构图不是时间顺序）。
  const order = sized.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const seed = 91.7 + index * 3.7;
    const swap = Math.floor(seededFraction(seed) * (index + 1));
    const tmp = order[index] ?? 0;
    order[index] = order[swap] ?? 0;
    order[swap] = tmp;
  }

  /*
   * 5. 落位（**用户第 9 轮第 1 条**：从「四根柱子的栏」换成「细槽」）。
   *
   * 老口径：`body` 进最矮的栏、hero 跨两栏挑「被覆盖栏最大高度最小」的起始栏，
   * `x = column × (columnWidth + gap)` —— 块的**盒子等于整栏**，短句右侧留一大片死空白。
   * 新口径：槽宽 `columnWidth / SLOT_DIVISOR`（下限 24px）、净空 `gap × GUTTER_RATIO`，
   * 每块按自己的真实宽占槽（盒宽已在第 3 步缩到文字宽），下一块贴着它右边落。
   */
  const slotPx = Math.max(SLOT_MIN_PX, Math.round(columnWidth / SLOT_DIVISOR));
  const gutter = Math.max(Math.round(gap * GUTTER_RATIO), 10);
  const packItems: FumePackItem[] = [];
  for (const orderIndex of order) {
    const item = sized[orderIndex];
    if (item === undefined) continue;
    // 本轮第 3 条之后这两支恒为 0（`BLOCK_GAP_*` = 0）：旧写法那个 4px / 2px 的地板也一起拆掉 ——
    // 地板在「比例已经收到 0」之后就成了唯一的间距来源，留着等于没收到图 2 那种密度。
    const gapBefore = item.hero
      ? Math.round(item.lineHeightPx * BLOCK_GAP_HERO)
      : Math.round(item.lineHeightPx * BLOCK_GAP_BODY);
    packItems.push({ width: item.width, height: item.height, gapBefore });
  }
  const packed = packFumeSlots(packItems, {
    paperWidth,
    paperHeight,
    slotPx,
    gutter,
    pageGapPx: gap * 4,
  });
  const blocks: FumeBlock[] = [];
  let packedIndex = 0;
  for (const orderIndex of order) {
    const item = sized[orderIndex];
    if (item === undefined) continue;
    const slot = packed[packedIndex];
    packedIndex += 1;
    if (slot === undefined) continue;
    const { line, hero, width, weight, fontPx, lineHeightPx, height, words } = item;
    blocks.push({
      index: line.index,
      text: line.text,
      hero,
      weight,
      fontPx,
      lineHeightPx,
      column: slot.slot,
      span: slot.span,
      x: slot.x,
      y: slot.y,
      width,
      height,
      words,
      startMs: item.line.timeMs,
      endMs: item.line.timeMs + item.line.durationMs,
      lineDurationMs: item.line.durationMs,
      translated: translated.get(line.timeMs),
    });
  }
  // 放不下的块会被「再铺一张纸」（`pageOffset`）推到 `paperHeight` 之下。相机那条
  // 那时「纸面必须盖住视口」的约束是拿 `paperWidth / paperHeight` 算的，所以这里把纸面撑到
  // 内容真实边界——否则唱到后面几页时，焦点在纸面之外、约束会把相机夹回底边，
  // 正在打印的块反而被顶出屏幕。**用户 m00002 第 1 条**起那条约束已经拆掉（相机只把焦点压在视口正中），
  // 所以这几个字段现在不再是「兜底边界」，而是**探针 / 未来接缝用的内容真实外接框**：撑大只影响
  // 世界层 div 的尺寸（绝对定位子元素本来就越界渲染），不影响列布局（列参数每帧都由视口重算）。
  let contentRight = paperWidth;
  let contentBottom = paperHeight;
  // 第十一轮第 1 条：同时记内容的**左上**角（块是贴着纸面左边 / 上边排的）。
  // **用户 m00002 第 1 条**后相机不再用它们夹取（那句「钉住当前句左缘」也在第二遍里拆了，
  // 见 `focusCameraOffset`）；保留是因为它们仍是「内容真实边界」的唯一来源，缩略图 / 探针要用。
  // 没有任何块时退化成纸面中心 ⇒ 与旧行为完全一致。
  let contentLeft = paperWidth * 0.5;
  let contentTop = paperHeight * 0.5;
  for (const block of blocks) {
    contentRight = Math.max(contentRight, block.x + block.width);
    contentBottom = Math.max(contentBottom, block.y + block.height);
    contentLeft = Math.min(contentLeft, block.x);
    contentTop = Math.min(contentTop, block.y);
  }
  return {
    paperWidth: contentRight,
    paperHeight: contentBottom,
    blocks,
    contentLeft: Math.min(contentLeft, contentRight),
    contentTop: Math.min(contentTop, contentBottom),
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

interface FumeBlockViewProps {
  readonly block: FumeBlock;
  readonly registerBlock: (index: number, element: HTMLDivElement | null) => void;
  readonly registerGlyph: (key: string, element: HTMLSpanElement | null) => void;
}

function FumeBlockView({ block, registerBlock, registerGlyph }: FumeBlockViewProps): ReactNode {
  const hero = block.hero;
  return (
    <div
      className={`pi-lyricfume__block${hero ? ' pi-lyricfume__block--hero' : ''}`}
      // 父代理的「点歌词行 seek」靠事件委托：块 = 一行歌词，块左上角就是这一行的时间。
      data-lyric-line={block.index}
      data-line-time={block.startMs}
      // `LyricStage.tsx:26-27` 的行元素契约要 `data-active`：fume 的「当前行」就是正在打印的
      // 那一块（`hero`），别的四套主题都写了这个属性，缺了它冒烟的歌词轨道探针会读成 active=-1。
      data-active={hero}
      ref={(element) => {
        registerBlock(block.index, element);
      }}
      style={
        {
          left: `${block.x.toFixed(2)}px`,
          top: `${block.y.toFixed(2)}px`,
          width: `${block.width.toFixed(2)}px`,
          '--pi-fume-font': `${block.fontPx.toFixed(2)}px`,
          '--pi-fume-line-height': `${block.lineHeightPx.toFixed(2)}px`,
          '--pi-fume-weight': hero ? '780' : '640',
        } as CSSProperties
      }
    >
      <div className="pi-lyricfume__text">
        {block.words.map((clump) => (
          <span className="pi-lyricfume__word" key={`${clump.wordIndex}-${clump.color}`}>
            {clump.glyphs.map((glyph, glyphIndex) => (
              <span
                className="pi-lyricfume__glyph"
                data-glyph
                key={`${glyphIndex}-${glyph.text}`}
                ref={(element) => {
                  registerGlyph(`${block.index}:${clump.wordIndex}:${glyphIndex}`, element);
                }}
              >
                {glyph.text}
              </span>
            ))}
          </span>
        ))}
      </div>
      {/*
       * **用户本轮第 1 条**：这里原来挂的是「译文」那一行 —— 现在译文搬到了底部的字幕层
       * （`.pi-lyricfume__sub`，与流光同构），纸面上只留**原文**，构图才与参考图一致。
       */}
    </div>
  );
}

/**
 * 浮名主题。
 *
 * 每帧：把纸面 wrapper 按弹簧相机位移 / 缩放，再给「当前块」的每个字素写 opacity / color / textShadow，
 * 其余块只在状态跨越时写一次。全程不 setState、不新建 / 销毁节点、不查 DOM。
 */
export function FumeTheme(props: LyricThemeProps): ReactNode {
  const { lines, translated, activeIndex, viewIndex, positionMs, playing, theme } = props;
  // 用户 m01402 第 3 条：整首时长（拿不到就是 0 = 不知道），只服务曲尾「剩余 N 秒」那条判据。
  const durationMs = props.durationMs ?? 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const glyphRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  // 舞台 = 整个播放页可视区域（首帧 / 量不到回退视口）；窗口缩放由 ResizeObserver 重算。
  const stage = useFullStageSize(rootRef);
  const viewportWidth = stage.width;
  const viewportHeight = stage.height;
  // canvas 度量必须和 DOM 同一套字体栈，否则量出来的宽度和真实折行对不上。
  const fontFamily = useElementFontFamily(rootRef);
  // **用户第 5 轮第 2 条**：暂停时不外推（否则会先走几步再猛地回到暂停位置）。
  const clock = usePositionClock(positionMs, playing ?? true);
  const reduced = usePrefersReducedMotion();
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;

  const plan = useMemo(
    () => buildFumePlan(lines, translated, viewportWidth, viewportHeight, theme, fontFamily),
    [fontFamily, lines, translated, viewportWidth, viewportHeight, theme],
  );

  // 设置里的动效参数（字号走 plan，其余三个走 rAF）。取成局部变量是为了给下面那个
  // effect 一个**具体**的依赖：直接写 `theme` 会因为主题色每次换歌都变而白重启一次循环。
  const tuning = tuningOf(theme);

  // 颜色跟随歌曲：祖先注入的 `--pi-th-*`（播放页按当前歌曲封面注入）优先，palette 兜底，
  // 再按底色做对比度兜底。rAF **每帧从 `paintRef.current` 现读**，换歌后下一帧就换色。
  const liveColors = useResolvedThemeColors(rootRef, theme);
  const paint = buildFumePaint(liveColors.current);
  const paintRef = useRef<FumePaint>(paint);
  paintRef.current = paint;

  const blocks = plan.blocks;
  /** 最后一块歌词的结束时间 —— 第十五轮第 6 条「整首歌词已经唱完」的判据基准。 */
  const lastEndMs = useMemo(
    () => blocks.reduce((max, block) => Math.max(max, block.endMs), 0),
    [blocks],
  );
  const viewBlock = useMemo(() => {
    for (const block of blocks) if (block.index === viewIndex) return block;
    return undefined;
  }, [blocks, viewIndex]);
  const activeBlock = useMemo(() => {
    for (const block of blocks) if (block.index === activeIndex) return block;
    return undefined;
  }, [blocks, activeIndex]);

  /**
   * 第十五轮第 6 条：整首歌词唱完之后，把镜头拉到「整张纸铺满视口」。
   * 判据与缩放值都在 `fumeOutroPlan` 里（纯函数，另有单测）。
   * 注意这里用的是播放器传进来的 `positionMs`（不是 rAF 里平滑过的 clock）：差一次属性更新
   * （≤ 数百 ms）就能翻转，换来的是「DOM 该挂哪些块」这件事在渲染期就有定论。
   */
  const outro = useMemo(
    () =>
      fumeOutroPlan(
        positionMs,
        lastEndMs,
        plan.paperWidth,
        plan.paperHeight,
        viewportWidth,
        viewportHeight,
        durationMs,
      ),
    [
      durationMs,
      lastEndMs,
      plan.paperHeight,
      plan.paperWidth,
      positionMs,
      viewportHeight,
      viewportWidth,
    ],
  );
  // 拆成两个**标量**再进 effect 依赖：`outro` 每次 `positionMs` 更新都是一个新对象，直接当依赖
  // 会让整个 rAF（连弹簧状态机）每几百 ms 重启一次。
  const outroActive = outro.active;
  const outroScale = outro.scale;
  /** 歌词还没唱完、整首已经只剩不到 5s（`data-fume-state='outro-soon'` 用；唱完时它是 false）。 */
  const outroSoon = fumeOutroSoon(positionMs, lastEndMs, durationMs);

  /**
   * 挂哪些块。
   *
   * **用户本轮第 2 条**（四张参考图）：folia 的纸是**一整张印满字的纸** —— 屏幕上高亮那句四周
   * 全是别的句子（大字小字混排）。原来这里只按**时间序**取「当前句 ±（8 / 12）行」，而这张纸是
   * **打乱**过的（`buildFumePlan` 第 4 步）⇒ 时间上相邻的块在纸上离得很远，相机四周真正挨着的
   * 那些块**根本没挂进 DOM**，屏幕自然就空。
   *
   * 现在按**空间**取：以当前句（`activeBlock ?? viewBlock`）为中心，把屏幕对角线 0.9 倍半径内的块
   * 全部挂上（再并上时间序那一窗，保证当前句前后几行一定在）。结尾缩镜那一档仍然全挂。
   */
  const visible = useMemo(() => {
    if (outroActive) return blocks;
    const focus = activeBlock ?? viewBlock;
    const radius = Math.hypot(viewportWidth, viewportHeight) * FUME_VISIBLE_RADIUS;
    const radiusSq = radius * radius;
    const cx = focus === undefined ? undefined : focus.x + focus.width * 0.5;
    const cy = focus === undefined ? undefined : focus.y + focus.height * 0.5;
    return blocks.filter((block) => {
      if (block.index >= viewIndex - WINDOW_BACK && block.index <= viewIndex + WINDOW_AHEAD) {
        return true;
      }
      if (cx === undefined || cy === undefined) return false;
      const dx = block.x + block.width * 0.5 - cx;
      const dy = block.y + block.height * 0.5 - cy;
      return dx * dx + dy * dy <= radiusSq;
    });
  }, [activeBlock, blocks, outroActive, viewBlock, viewIndex, viewportHeight, viewportWidth]);

  /*
   * **用户本轮第 1 条**当年是在浮名里复刻了一层字幕（译文 + 两句原文预览）；
   * **用户第 8 轮第 2 条**（原话：「所有的歌词动效的翻译歌词都设置在进度条部件的上面，
   * 并且一次只显示一句」）之后这件事收归 `LyricStage`：六套主题共用同一层、一次只显示一句。
   * 本主题自己那份整段删掉（`translated` 这个 prop 仍然要传给 `buildFumePlan` —— 纸面布局
   * 会用它，见那一处调用）。
   */

  // 相机状态：只在 rAF 闭包里维护。
  const cameraRef = useRef({
    x: 0,
    y: 0,
    scale: INITIAL_CAMERA_SCALE,
    velocityX: 0,
    velocityY: 0,
    zoomVelocity: 0,
    seeded: false,
  });

  useEffect(() => {
    const root = rootRef.current;
    const world = worldRef.current;
    if (root === null || world === null) return undefined;

    /*
     * **用户 m00002 第 1 条**的清理：这个 effect 每换一句都会重启一次（依赖里有 `activeBlock`），
     * 而世界层的 DOM 节点在重启之间是**留着**的 —— 上一次挂的 `data-fume-focus` 不会自己消失。
     * 不清掉的话，`document.querySelector('[data-fume-focus]')` 会取到**旧的那一颗**（文档顺序里
     * 靠前的那一颗往往在几百甚至上千像素外），冒烟探针量到的就不是镜头此刻对准的字了
     *（实测：偏差 2249px 的假红）。这里每次都把世界层里的旧标记扫干净，只留本 effect 自己挂的那一颗。
     */
    for (const stale of world.querySelectorAll('[data-fume-focus]')) {
      delete (stale as HTMLElement).dataset.fumeFocus;
    }

    const calm = theme.animationIntensity === 'calm';
    const chaotic = theme.animationIntensity === 'chaotic';
    // 设置项（辉光强度 / 动效幅度 / 帧率上限 / 镜头追焦）在 effect 起点取一次：`theme` 是稳定引用的
    // palette，它变一次 effect 就重启一次，所以这里当闭包常量用，不必每帧查表。
    const { fpsCap, glowIntensity, motionAmount, fumeCameraFollow, fumeCameraSpeed } =
      tuningOf(theme);
    // 镜头追焦（第十四轮第 3 条）：速度倍率夹一次兜底，`1` = 改造前那组弹簧常数的等效速度；
    // `snap` = 定格（切句瞬间直接换机位，没有插值）。
    const cameraSpeed = clamp(fumeCameraSpeed, FUME_CAMERA_SPEED_MIN, FUME_CAMERA_SPEED_MAX);
    const snapCamera = fumeCameraFollow === 'snap';
    const frameGate = createFrameGate(fpsCap);
    // 原来那个 `* 1` 就是 folia 留给 glowIntensity 的位子：辉光的两档强度都乘它。
    const glyphGlowBoost = (chaotic ? 1.15 : calm ? 0.72 : 0.92) * glowIntensity;
    const passedGlowBase = (chaotic ? 0.95 : calm ? 0.35 : 0.62) * glowIntensity;
    const targetLineHeight = clamp(
      Math.min(viewportWidth, viewportHeight) * CAMERA_LINE_HEIGHT_RATIO,
      CAMERA_LINE_HEIGHT_MIN,
      CAMERA_LINE_HEIGHT_MAX,
    );
    // 每个块上一次的「阶段」（waiting / active / passed），只在跨越时写整块样式。
    const phaseCache = new Map<number, string>();
    /**
     * **用户第 6 轮第 1 条**：结尾那句高光已经画到哪一个渐散进度。
     * 相位没变时块本来不重绘，而渐散是「相位不变、颜色一直在变」——不记这一笔，高光会僵在起始色上。
     */
    let outroFadePainted = -1;
    const glyphGlowCache = new Map<string, number>();
    /**
     * **用户 m00002 第 1 条（第二遍）**：镜头速度的一阶低通（屏幕 px/s，只用于「褪色速率」）。
     * 见 `FUME_TRAIL_SPEED_*`：镜头走得快 ⇒ 唱过的那一段褪得更快。
     */
    let trailSpeed = 0;

    /**
     * **用户 m00380 / m00002 第 1 条**：把一坨词的原始颜色解析成 `rgb()`。
     *
     * 为什么要解析：主题 palette 的 `accentColor` 默认是 CSS 变量链
     * （`var(--pi-np-accent, var(--pi-primary))`，见 types.ts 里 `LyricPalette` 的默认值），
     * `wordColorOf(palette, text, palette.accentColor)` 会把这条链**原样**塞进 `clump.color`；
     * 而 `mixColor` / `fumeTrailColor` 只认 `rgb()/rgba()`（`parseRgb` 解析失败就**原样返回第一个
     * 参数**）⇒ `fumeTrailColor(clump.color, palette, p)` 对任何 `p` 都吐那支主题原色，唱过的字
     * 永远回不到 `palette.fadeTo`（暗档白 / 亮档墨色）。用户看到的就是「高亮**左边**那半句一直挂着
     * 主题色」——m00380 那条反馈的根因（块色走的是解析过的 `palette.hot`，所以块级淡出一直是对的）。
     *
     * 解析放在**绘制时**而不是 plan 里：`buildFumePlan` 是 useMemo（换行不该重排版），而且首帧
     * render 时 root 还没挂载（`resolveCssColor(null, …)` 会原样返回，白解析一次）。
     * 同一条原始串在一次 effect 生命周期里只解析一次（`clumpColors` 随 effect 重建）。
     */
    const clumpColors = new Map<string, string>();
    const clumpColorOf = (raw: string): string => {
      const cached = clumpColors.get(raw);
      if (cached !== undefined) return cached;
      const resolved = parseRgb(raw) !== null ? raw : resolveCssColor(rootRef.current, raw);
      clumpColors.set(raw, resolved);
      return resolved;
    };

    /**
     * **用户 m00002 第 1 条**：量一块歌词「文字实际占位」的世界坐标（定义见 `FumeTextBox`）。
     *
     * 量的是**字素 span 的并集外接框**（`.pi-lyricfume__glyph`），也就是歌词文字本身：
     *  · 不量 `.pi-lyricfume__block`：那是**块框**（排版列宽），hero 块跨两列 ≈ 0.98 视口宽，
     *    而短句的文字只占框左边一小截 —— 按框中心对出来的机位与文字没关系。
     *  · 也不量 `.pi-lyricfume__text`（Range 选子树）：它里面还有**译文**那一行（`.pi-lyricfume__translated`，
     *    `display: block`），译文比原文宽时会把并集撑大、把中心带偏；用户要居中/要看得清的是「歌词」。
     *    冒烟探针量的也是字素并集，两边必须同源，否则探针会因为「量错了东西」误判。
     *
     * 归一化用「块自己的屏幕宽 / `block.width`」这个比值，而不是相机的 `scale`：块外层的
     * `transform: scale()` 把子元素一起缩了，比值就是那个缩放系数，与当前机位 / 是否已经写过
     * transform 都无关（首帧 `paintStatic` 时世界层还没有 transform，用 `camera.scale` 会差一档）。
     *
     * **用户 m00002 第 1 条（第二遍）**：除了文字的并集，这里还**逐颗**记下每个字素的框
     * （`glyphs[i]`，顺序 = DOM 顺序 = `block.words` 的词序 × 词内字素序，与 `spans` / `keys` 一一对应）
     * —— 镜头现在要对准的是**正在唱的那一颗字**（`resolveFocus`），只有并集中心是不够的。
     * 三样东西（框 / 时间表 / DOM 键）在同一趟里一起建好并按块号缓存。
     *
     * 每块只量一次：结果按块号缓存到本次 effect 的闭包里，plan / 视口 / 字体一变 effect 重启、
     * 缓存随之重建；rAF 热路径只查表，不碰布局。量不到（元素还没挂载 / 还没布局）返回 `undefined`
     * 且**不缓存**，下一帧自动重试。
     */
    const probes = new Map<number, FumeBlockProbe>();
    const probeOf = (block: FumeBlock): FumeBlockProbe | undefined => {
      const cached = probes.get(block.index);
      if (cached !== undefined) return cached;
      const element = blockRefs.current[block.index];
      if (element === null || element === undefined) return undefined;
      const blockRect = element.getBoundingClientRect();
      if (blockRect.width <= 0) return undefined;
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      // 从「块的屏幕盒」换算回世界坐标：块的左上角是 `block.x / block.y`，缩放系数 = 屏幕宽 / 世界宽。
      const ratio = block.width / blockRect.width;
      const worldBox = (rect: DOMRect): FumeTextBox => ({
        left: block.x + (rect.left - blockRect.left) * ratio,
        top: block.y + (rect.top - blockRect.top) * ratio,
        width: rect.width * ratio,
        height: rect.height * ratio,
      });
      // 字素的时间表 / DOM 键（与下面那个 NodeList 同序，见 `FumeBlockView` 的渲染顺序）。
      const spans: FumeGlyphSpan[] = [];
      const keys: string[] = [];
      for (const clump of block.words) {
        for (let index = 0; index < clump.glyphs.length; index += 1) {
          const glyph = clump.glyphs[index];
          if (glyph === undefined) continue;
          spans.push({ startMs: glyph.startMs, endMs: glyph.endMs });
          keys.push(`${block.index}:${clump.wordIndex}:${index}`);
        }
      }
      const glyphs: (FumeTextBox | undefined)[] = [];
      let glyphIndex = 0;
      for (const glyph of element.querySelectorAll('.pi-lyricfume__glyph')) {
        const rect = glyph.getBoundingClientRect();
        const measurable = rect.width > 0 || rect.height > 0;
        glyphs[glyphIndex] = measurable ? worldBox(rect) : undefined;
        glyphIndex += 1;
        if (!measurable) continue;
        if (rect.left < left) left = rect.left;
        if (rect.right > right) right = rect.right;
        if (rect.top < top) top = rect.top;
        if (rect.bottom > bottom) bottom = rect.bottom;
      }
      if (!Number.isFinite(left) || right <= left || bottom <= top) return undefined;
      const probe: FumeBlockProbe = {
        text: {
          left: block.x + (left - blockRect.left) * ratio,
          top: block.y + (top - blockRect.top) * ratio,
          width: (right - left) * ratio,
          height: (bottom - top) * ratio,
        },
        glyphs,
        spans,
        keys,
      };
      probes.set(block.index, probe);
      return probe;
    };

    /**
     * **用户 m00002 第 1 条**的可判定接缝：把「镜头此刻正对着的那颗字素」写到它的
     * `data-fume-focus="true"` 上（换一颗时先摘掉上一颗的）。
     *
     * 为什么需要：镜头语义从「句中心」变成「正在唱的那颗字」之后，外面（冒烟探针 / 用户排查）
     * 没法再从「当前句文字并集的中心」反推镜头该对准谁 —— 那个中心是死的。有了这个标记，
     * 探针只需量 `[data-fume-focus]` 的矩形与窗口中心的差，量的就是镜头该做的事本身。
     * 只在换字时写一次（一句里换几十次，不是每帧）。
     */
    let focusMark: string | null = null;
    const markFocusGlyph = (key: string | null): void => {
      if (key === focusMark) return;
      if (focusMark !== null) {
        const previous = glyphRefs.current[focusMark];
        if (previous !== null && previous !== undefined) delete previous.dataset.fumeFocus;
      }
      focusMark = key;
      if (key === null) return;
      const element = glyphRefs.current[key];
      if (element !== null && element !== undefined) element.dataset.fumeFocus = 'true';
    };
    // （旧标记的跨-effect 清理在 effect 开头已经做过一遍：见上面那段「用户 m00002 第 1 条」的
    //  `world.querySelectorAll('[data-fume-focus]')` 扫描。）

    /** 静止渲染（减少动效 / 初始化时用）。 */
    const paintStatic = (): void => {
      const ms = positionRef.current;
      const paintNow = paintRef.current;
      // **用户 m00001**：静止渲染的「当前句」色也取热色（亮档 primary = 改造前 / 暗档 accent），与 rAF 同源。
      const hot = paintNow.hot;
      const camera = cameraRef.current;
      const contentBlock = activeBlock ?? viewBlock;
      // 第十五轮第 6 条：静止渲染也要能给出「整张纸铺满视口」这一档（判据与 rAF 同源）。
      const staticFocus = resolveFocus(activeBlock, viewBlock, probeOf, ms);
      markFocusGlyph(staticFocus?.glyphKey ?? null);
      const scale = outroActive ? outroScale : INITIAL_CAMERA_SCALE;
      camera.scale = scale;
      if (outroActive) {
        camera.x = fumeOutroOffset(
          staticFocus?.worldX ?? plan.paperWidth * 0.5,
          plan.paperWidth,
          viewportWidth,
          scale,
        );
        camera.y = fumeOutroOffset(
          staticFocus?.worldY ?? plan.paperHeight * 0.5,
          plan.paperHeight,
          viewportHeight,
          scale,
        );
      } else {
        // **用户 m00002 第 1 条**：与 rAF 同源 —— 当前**正在唱的那颗字素**压在视口正中
        // （`CAMERA_FOCUS_Y = 0.5`），横纵都不夹取（见 `focusCameraOffset`）。
        // 焦点取不到时退回纸面中心。
        camera.x = focusCameraOffset(
          viewportWidth * 0.5,
          staticFocus?.worldX ?? plan.paperWidth * 0.5,
          viewportWidth,
          scale,
        );
        camera.y =
          viewportHeight * CAMERA_FOCUS_Y - (staticFocus?.worldY ?? plan.paperHeight * 0.5) * scale;
      }
      camera.velocityX = 0;
      camera.velocityY = 0;
      camera.zoomVelocity = 0;
      camera.seeded = true;
      world.style.transform = `translate3d(${camera.x.toFixed(2)}px, ${camera.y.toFixed(
        2,
      )}px, 0) scale(${scale})`;
      // 第十五轮第 6 条的可判定接缝：世界缩放写到 `data-fume-scale`（缩小态一定 < 1）。
      world.dataset.fumeScale = scale.toFixed(3);
      // 第十五轮第 6 条：结尾镜头里最后一句保持高亮（主题色 + 满不透明），其余照旧「唱过」的淡白。
      // **用户第 6 轮第 1 条**：这句的高光随结尾镜头**渐散**（与 rAF 路径同源）。
      const outroFocusIndex = outroActive ? contentBlock?.index : undefined;
      const staticOutroFade = outroActive ? fumeOutroFocusFade(ms, lastEndMs, durationMs) : 0;
      for (const block of visible) {
        const element = blockRefs.current[block.index];
        if (element === null || element === undefined) continue;
        const passed = ms > block.endMs;
        const active = !passed && ms >= block.startMs;
        const alpha = active
          ? block.hero
            ? 0.985
            : 0.92
          : passed
            ? // **用户 m00002 第 1 条（第二遍）**：静止渲染里「唱过」那档同样按 `passedDim` 压暗，
              // 免得开了「减少动效」之后暗档又变回那条比高亮还亮的白（与 rAF 路径同源）。
              (block.hero ? paintNow.passedAlphaHero : paintNow.passedAlphaBody) *
              paintNow.passedDim
            : block.hero
              ? paintNow.waitAlphaHero
              : paintNow.waitAlphaBody;
        const isOutroFocus = outroFocusIndex !== undefined && block.index === outroFocusIndex;
        // 第十五轮第 4 条：常态（未唱 / 唱过）白、当前高亮句才主题色；第 6 条：结尾那句继续高亮。
        element.style.opacity = isOutroFocus ? '1' : alpha.toFixed(3);
        // **用户本轮第 2 条**：静止渲染同样分两档 —— 唱过用深档 `ink`、还没唱到用浅档 `waitInk`。
        element.style.color = isOutroFocus
          ? mixColor(paintNow.accent, paintNow.fadeTo, staticOutroFade)
          : active
            ? hot
            : passed
              ? paintNow.ink
              : paintNow.waitInk;
        element.style.textShadow = 'none';
        element.style.filter = 'none';
      }
      for (const glyph of Object.values(glyphRefs.current)) {
        if (glyph === null || glyph === undefined) continue;
        glyph.style.color = 'inherit';
        glyph.style.opacity = '1';
        glyph.style.textShadow = 'none';
      }
    };

    if (reduced) {
      paintStatic();
      return undefined;
    }

    let frame = 0;
    let running = false;
    let last = performance.now();
    const tick = (now: number): void => {
      // 帧率上限：这一帧不许画就整帧跳过（含所有样式写入），只把 rAF 链接下去。
      // `last` 故意不更新，下一次通过的 dt 才是「距上帧真实经过的时间」，相机速度不会抖。
      // `fpsCap === 'off'` 时 frameGate 恒为 true，路径与加这个旋钮之前完全一致。
      if (!frameGate(now)) {
        if (running) frame = window.requestAnimationFrame(tick);
        return;
      }
      const dt = clamp((now - last) / 1000, 1 / 240, 0.05);
      last = now;
      const ms = clock.current();
      const camera = cameraRef.current;
      // 颜色每帧现读：换歌 / 切换亮暗 → 祖先重写 `--pi-th-*` → 下一帧就是新色（相机不重启）。
      const palette = paintRef.current;
      // 目标：当前**正在唱的那颗字素**（**用户 m00002 第 1 条**：镜头中心跟着高亮的字走）。
      // 由 `probeOf` 量出来的逐字素世界框给（块框中心 / 句中心都是死的，高亮在句内会移动）。
      // 没有激活块（还没唱到第一句 / 手动查看）时退化成 `viewBlock` 的那颗。
      const focus = resolveFocus(activeBlock, viewBlock, probeOf, ms);
      // 可判定接缝：镜头对准的那颗字素挂 `data-fume-focus`（见 `markFocusGlyph`）。
      markFocusGlyph(focus?.glyphKey ?? null);
      const focusLineHeight = focus?.lineHeightPx ?? 48;
      // 第十五轮第 6 条：歌词全部唱完 ⇒ 缩放目标换成「整张纸铺满视口」那一档；这一档允许低于
      // `CAMERA_SCALE_MIN`（否则永远缩不到「能一次看全整首歌词」的比例）。
      const scaleFloor = outroActive ? FUME_OUTRO_SCALE_MIN : CAMERA_SCALE_HARD_MIN;
      // 动效幅度裁的是「离 1 有多远」：motionAmount = 1 时结果与加这个旋钮之前逐位相同，
      // 调小 → 推近/拉远收敛成接近原始比例，调大 → 更冲。硬上下限由后面的 framingScale 兜底。
      const rawScaleTarget = outroActive
        ? outroScale
        : clamp(
            targetLineHeight / Math.max(focusLineHeight, 1),
            CAMERA_SCALE_MIN,
            CAMERA_SCALE_MAX,
          );
      const scaleTarget = outroActive
        ? outroScale
        : clamp(1 + (rawScaleTarget - 1) * motionAmount, CAMERA_SCALE_MIN, CAMERA_SCALE_MAX);
      // 相机按 `scaleTarget`（弹簧的收敛值）算目标位姿：世界点 w 的屏幕位置是 `x + w * s`，
      // 所以平移量必须带 `* s`——旧写法漏了这一项，scale > 1 时焦点会被 `w * (s - 1)` 推离锚点，
      // 靠后的列甚至会被推出屏幕（窗口越宽 / 越高越明显）。夹取再保证纸面始终盖住视口。
      const framingScale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
      const focusWorldX = focus?.worldX ?? plan.paperWidth * 0.5;
      const focusWorldY = focus?.worldY ?? plan.paperHeight * 0.5;
      const contentBlock = activeBlock ?? viewBlock;
      // **用户 m00002 第 1 条**：不再按「纸面必须盖住视口」算目标、也不再钉住当前句左缘 —— 纵向
      // 直接把高亮字放到 `viewportHeight * CAMERA_FOCUS_Y`（= 正中），横向同理；纸面比视口小时会
      // 露出沉浸式背景图，这是有意的（歌词页本来就没有纸面底色）；已经唱过的那一截随镜头滑出左边
      // 是「跟着高亮推进」的应有之义（见 `focusCameraOffset` 的注释）。
      // 第十五轮第 6 条：结尾镜头把高亮句推到视口中心，但整张纸不许出画（`fumeOutroOffset`）。
      const targetX = outroActive
        ? fumeOutroOffset(focusWorldX, plan.paperWidth, viewportWidth, framingScale)
        : focusCameraOffset(viewportWidth * 0.5, focusWorldX, viewportWidth, framingScale);
      const targetY = outroActive
        ? fumeOutroOffset(focusWorldY, plan.paperHeight, viewportHeight, framingScale)
        : viewportHeight * CAMERA_FOCUS_Y - focusWorldY * framingScale;
      // 追焦方式（第十四轮第 3 条）：`snap` = 定格，切句瞬间直接换机位、速度清零，没有插值。
      if (!camera.seeded) {
        // 首帧 / 重新挂载：不插值直接落位，免得从 (0, 0) 或上一首歌的位姿弹簧过去。
        camera.x = targetX;
        camera.y = targetY;
        camera.scale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
        camera.velocityX = 0;
        camera.velocityY = 0;
        camera.zoomVelocity = 0;
        camera.seeded = true;
      } else if (snapCamera && !outroActive) {
        // 第十五轮第 6 条：结尾那次「缩小铺满」即使设置成「定格」也要**插值**走过去
        //（否则整张纸会瞬间跳成一张缩略图，而用户第 6 条要的是「缩小画面」这个过程）。
        camera.x = targetX;
        camera.y = targetY;
        camera.velocityX = 0;
        camera.velocityY = 0;
      } else {
        // `duration` / 弹簧强度 / 阻尼 / 限速都沿用改造前那套（换算见 `cameraSpring`），
        // 只把「速度」量纲乘 `cameraSpeed`：`ω' = ω × s` ⇔ `k' = k × s²`、`c' = c × s`。
        const duration = Math.max((focus?.catchUpMs ?? 1600) / 1000, 0.05);
        // **用户 m00002 第 1 条（第二遍）**：跟字是「匀速移动的目标」，二阶系统对它有一条稳态滞后
        // `≈ 2ζ·v/ω`。所以**弹簧**取 `FUME_FOLLOW_CATCHUP_MS`（ω 顶到上限，滞后压到几十像素内），
        // 而**限速**仍按整句时长算 —— 换句那趟长距离飞行的巡航速度与手感逐位不变。
        const springDuration = Math.min(duration, FUME_FOLLOW_CATCHUP_MS / 1000);
        const { omega, zeta } = cameraSpring(springDuration, cameraSpeed);
        const maxVelocity =
          clamp(
            Math.hypot(targetX - camera.x, targetY - camera.y) / Math.max(duration * 0.28, 0.028),
            CAMERA_VELOCITY_MIN,
            CAMERA_VELOCITY_MAX,
          ) * cameraSpeed;
        // 限速在积分之前（改造前也是先夹速度、再拿夹过的速度推位置）。
        const velocityMag = Math.hypot(camera.velocityX, camera.velocityY);
        if (velocityMag > maxVelocity) {
          const factor = maxVelocity / velocityMag;
          camera.velocityX *= factor;
          camera.velocityY *= factor;
        }
        const nextX = springStep(camera.x, camera.velocityX, targetX, omega, zeta, dt);
        camera.x = nextX.position;
        camera.velocityX = nextX.velocity;
        const nextY = springStep(camera.y, camera.velocityY, targetY, omega, zeta, dt);
        camera.y = nextY.position;
        camera.velocityY = nextY.velocity;
      }
      // 第十轮第 5 条加固（用户 m02362：浮名歌词「会飘出窗口界面而显示不全」）：弹簧积分之后
      // **再夹一次**。只夹「目标位姿」不够——跨页时页偏移让 target 跳出去一整张纸
      // （`pageOffset += paperHeight + gap * 4`），过冲那几帧仍会把当前句推出去。
      // **用户 m00002 第 1 条（第二遍）**：播放期的横向夹取整条拆掉了。第十一轮那条「当前句文字比
      // 视口宽时钉住左缘」在「句中心对焦」的年代是兜底，在「跟着高亮字走」的年代却是致命伤：
      // 一句唱过一半之后，焦点字离句首已超过半屏，这条下界**每帧都生效**，高亮的字被钉在右半边
      // —— 用户要的「始终位于窗口中心」当场失效。现在只剩结尾镜头那一条（它与缩略图配套）。
      if (outroActive) {
        // 第十五轮第 6 条：结尾镜头按「整张纸铺满视口、高亮句居中、纸不许出画」夹取，
        // 不能再沿用「焦点居中」那条（它会和缩略图打架）。
        camera.x = fumeOutroOffset(focusWorldX, plan.paperWidth, viewportWidth, camera.scale);
        camera.y = fumeOutroOffset(focusWorldY, plan.paperHeight, viewportHeight, camera.scale);
      }
      if (snapCamera && !outroActive) {
        // 定格：缩放也直接给到位（`framingScale` 就是 `clamp(scaleTarget, 硬上下限)`）。
        camera.scale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
        camera.zoomVelocity = 0;
      } else {
        // 缩放弹簧也是同一条隐式解：`ω = √108 × cameraSpeed`、`ζ = 21 / (2√108) ≈ 1.01`。
        const nextScale = springStep(
          camera.scale,
          camera.zoomVelocity,
          scaleTarget,
          CAMERA_ZOOM_OMEGA * cameraSpeed,
          CAMERA_ZOOM_ZETA,
          dt,
        );
        camera.scale = nextScale.position;
        camera.zoomVelocity = nextScale.velocity;
      }
      camera.scale = clamp(camera.scale, scaleFloor, CAMERA_SCALE_HARD_MAX);
      // idle 浮动（世界位移要除以当前 scale）。整套飘移幅度乘设置的 `motionAmount`：
      // 位移用 `idleSpan`，缩放项乘在振幅上（`1 + 振幅 × motionAmount`，motionAmount = 1 时原样）。
      const idleSpan = IDLE_DISTANCE * motionAmount;
      const phase = (now / 1000 / IDLE_PERIOD_SEC) * Math.PI * 2;
      const idleX = (Math.sin(phase * 0.74 + 0.8) * idleSpan * 0.34) / camera.scale;
      const idleY =
        ((Math.sin(phase) * idleSpan + Math.sin(phase * 0.5 + 1.1) * idleSpan * 0.22) /
          camera.scale) *
        (1 + IDLE_SCALE_AMPLITUDE * motionAmount);
      world.style.transform = `translate3d(${(camera.x + idleX).toFixed(2)}px, ${(
        camera.y + idleY
      ).toFixed(2)}px, 0) scale(${camera.scale.toFixed(4)})`;
      // 第十五轮第 6 条的可判定接缝：世界缩放写到 `data-fume-scale`，只在第三位小数变化时写，
      // 避免每帧都动 dataset（探针可以直接读它断言「缩小」，不用解析 transform 的矩阵）。
      const scaleMark = camera.scale.toFixed(3);
      if (world.dataset.fumeScale !== scaleMark) world.dataset.fumeScale = scaleMark;

      // 当前正在打印的字素（用于「前沿」提示）。
      const activeKey = resolveFrontKey(activeBlock, ms);
      // **用户 m00002 第 1 条（第二遍）**：「歌词渐变褪色到速度随镜头移动速度有所变化」——
      // 镜头速度（弹簧的屏幕位移速度）经一阶低通后，换算成这一帧的**褪色速率倍率**（见 `FUME_TRAIL_SPEED_*`）。
      // 低通是必须的：弹簧在切句 / 过冲时会有尖峰，直接拿瞬时速度去改 colour trail 会让颜色一跳一跳。
      const cameraSpeedNow = Math.hypot(camera.velocityX, camera.velocityY);
      trailSpeed += (cameraSpeedNow - trailSpeed) * clamp(dt * FUME_TRAIL_SPEED_SMOOTH, 0, 1);
      const trailRate = clamp(
        trailSpeed / FUME_TRAIL_SPEED_REF,
        FUME_TRAIL_SPEED_MIN,
        FUME_TRAIL_SPEED_MAX,
      );
      // 第十五轮第 6 条：结尾镜头里「当前高亮的那一句」= 最后唱过的那一块（`activeBlock ?? viewBlock`），
      // 它在缩略图里保持主题色 + 满不透明，其余全部是淡白 —— 对应用户图 2 的样子。
      // **用户第 6 轮第 1 条**：这一句的高光要随着结尾镜头**渐散**（见 `fumeOutroFocusFade`）。
      const outroFocusIndex = outroActive ? contentBlock?.index : undefined;
      const outroFocusFade = outroActive ? fumeOutroFocusFade(ms, lastEndMs, durationMs) : 0;

      for (const block of visible) {
        const element = blockRefs.current[block.index];
        if (element === null || element === undefined) continue;
        const passed = ms > block.endMs;
        const active =
          !passed &&
          ms >= block.startMs &&
          activeBlock !== undefined &&
          block.index === activeBlock.index;
        // 第十五轮第 4 条：从「唱过」那一刻起，块色 / 亮度按 900ms **逐渐**淡回常态白（不是瞬间跳色）。
        // **用户 m00002 第 1 条**：块级淡出已经缩到 `FUME_PASSED_FADE_MS = 260ms`（「迅速开始渐变褪色」），
        // 但**逐字素**的 colour trail 最短也要 `TRAIL_DURATION_MAX = 0.45s`，所以「还要接着重绘」的窗口
        // 取两者中较长的那个（`FUME_PASSED_TRAIL_MS`）；否则 trail 会被冻在半路，字素永远停在
        // 一句「半褪」的颜色上（旧版正是这样：`fading` 一结束就再没人重绘字素）。
        const passedFade = passed ? clamp((ms - block.endMs) / FUME_PASSED_FADE_MS, 0, 1) : 1;
        const fading = passed && ms - block.endMs < FUME_PASSED_TRAIL_MS;
        const phase =
          outroFocusIndex !== undefined
            ? block.index === outroFocusIndex
              ? 'outro-current'
              : 'outro-away'
            : active
              ? 'active'
              : passed
                ? 'passed'
                : 'waiting';
        // 第十五轮第 4 条的可判定接缝：把这一块**当前所在的相位**写到 DOM（只在变化时写），
        // 探针不必解析内联样式就能区分 `waiting` / `active` / `passed` / `outro-current` / `outro-away`。
        if (element.dataset.fumePhase !== phase) element.dataset.fumePhase = phase;
        const previousPhase = phaseCache.get(block.index);
        const lineProgress = clamp((ms - block.startMs) / Math.max(block.lineDurationMs, 1), 0, 1);
        const envelope =
          lineProgress <= LINE_ENVELOPE_PEAK
            ? easeOutCubic(lineProgress / LINE_ENVELOPE_PEAK)
            : 1 - easeInCubic((lineProgress - LINE_ENVELOPE_PEAK) / (1 - LINE_ENVELOPE_PEAK));
        const hero = block.hero;
        /*
         * **用户第 6 轮第 1 条**：相位没变、但渐散进度一直在走 —— 结尾那一句必须继续重绘，
         * 否则高光会僵在「刚进结尾镜头」那一档上（相位缓存是给「只在变化时写 DOM」用的，
         * 高频变化的内联色不在它管的范围里）。
         */
        const fadeMoving =
          phase === 'outro-current' && Math.abs(outroFocusFade - outroFadePainted) > 0.005;
        if (previousPhase !== phase || active || fading || fadeMoving) {
          phaseCache.set(block.index, phase);
          if (phase === 'outro-current') {
            /*
             * 第十五轮第 6 条：结尾镜头里的高亮句 —— 主题色 + 满不透明 + 一圈主题色光晕。
             * **用户第 6 轮第 1 条**：随 `focusFade` 让高光**渐渐散去** —— 字色由 `accent` 混向
             * `fadeTo`（常态白）、光晕同步收掉；**亮度仍留 1**，所以它还是整张纸上最亮的那一句
             *（图 1 里最亮的那行正是它）。
             */
            outroFadePainted = outroFocusFade;
            element.style.color = mixColor(palette.accent, palette.fadeTo, outroFocusFade);
            element.style.opacity = '1';
            const outroGlowAlpha = 0.5 * (1 - outroFocusFade);
            element.style.textShadow =
              outroGlowAlpha <= 0.01
                ? 'none'
                : `0 0 ${((hero ? LINE_GLOW_BLUR_HERO : LINE_GLOW_BLUR_BODY) * 2).toFixed(2)}px ${glowColor(palette.accent, outroGlowAlpha)}`;
            paintPassedGlyphs(block, glyphRefs, glyphGlowCache);
          } else if (phase === 'outro-away') {
            // 其余整首歌词：常态白 + 「唱过」那档暗度（用户图 2 里那些白而淡的字）。
            element.style.color = palette.ink;
            element.style.opacity = (
              hero ? palette.passedAlphaHero : palette.passedAlphaBody
            ).toFixed(3);
            element.style.textShadow = 'none';
            paintPassedGlyphs(block, glyphRefs, glyphGlowCache);
          } else if (phase === 'active') {
            // 整行辉光 + 逐字素打印。
            const glowAlpha =
              (hero ? LINE_GLOW_ALPHA_HERO : LINE_GLOW_ALPHA_BODY) +
              envelope * (hero ? LINE_GLOW_ALPHA_SPAN_HERO : LINE_GLOW_ALPHA_SPAN_BODY);
            const glowBlur =
              (hero ? LINE_GLOW_BLUR_HERO : LINE_GLOW_BLUR_BODY) +
              envelope *
                block.fontPx *
                (hero ? LINE_GLOW_BLUR_SPAN_HERO : LINE_GLOW_BLUR_SPAN_BODY);
            element.style.textShadow = `0 0 ${glowBlur.toFixed(2)}px ${glowColor(palette.accent, glowAlpha)}`;
            // **用户 m00001**：块色取当前句的热色（亮档 `primary` = 改造前；暗档 `accent` = 封面那支粉）。
            element.style.color = mixColor(palette.hot, 'rgb(0, 0, 0)', ACTIVE_DARK_MIX);
            element.style.opacity = '1';
            paintActiveGlyphs(
              block,
              ms,
              activeKey,
              palette,
              glyphGlowBoost,
              glyphRefs,
              glyphGlowCache,
              trailRate,
              clumpColorOf,
            );
          } else if (phase === 'passed') {
            // 第十五轮第 4 条：唱过之后整块淡成常态色，残余光晕也随这段淡出一起淡到零
            //（「高亮时才有其他颜色（辉光）」——唱过就不该继续挂着主题色光晕）。
            const glow = (2 + block.fontPx * 0.1) * 0.65 * passedGlowBase * (1 - passedFade);
            // 第十五轮第 4 条 + **用户 m00002 第 1 条**：块色从**它上一帧还在用的**热色起，
            // 按同一条（`FUME_PASSED_FADE_MS = 260ms`）淡到常态色 —— `passedFade = 0` 那一帧等于
            // `palette.hot`，所以字素从热色接手时不会跳色；`passedFade = 1` 时正好是 `fadeTo`。
            // `fadeTo === ink`（暗档白、亮档对比度兜底后的墨色）⇒ 唱过就回原色；
            // 亮档 `hot === primary` 且 `fadeTo === ink` ⇒ 与改造前逐位一致。
            element.style.color = mixColor(palette.hot, palette.fadeTo, passedFade);
            element.style.opacity = mixNumber(
              1,
              hero ? palette.passedAlphaHero : palette.passedAlphaBody,
              passedFade,
            ).toFixed(3);
            element.style.textShadow =
              passedFade >= 1
                ? 'none'
                : `0 0 ${glow.toFixed(2)}px ${glowColor(palette.accent, 0.42 * (1 - passedFade))}`;
            // **用户 m00002 第 1 条**：唱过之后**继续用** `paintActiveGlyphs` 逐字素重绘，让每个字的
            // colour trail 自己从热色淡到 `palette.fadeTo`（块级那次 260ms 淡出只负责整块的亮度与
            // 「等待段变深」的收尾）。旧版在这里调 `paintPassedGlyphs`，它把字素的内联颜色打回
            // `inherit` —— 结果整句先「啪」地跳成块色（热色）再随块级渐变淡一遍，看起来是闪一下。
            paintActiveGlyphs(
              block,
              ms,
              activeKey,
              palette,
              glyphGlowBoost,
              glyphRefs,
              glyphGlowCache,
              trailRate,
              clumpColorOf,
            );
          } else {
            /*
             * **用户本轮第 2 条**（图）：这一档是「还没唱到」的块 —— 用**原色的浅档** `waitInk`
             *（= `ink` 往底色里混 `WAIT_TINT_MIX`），而「已经唱过」那一档走的是深档 `ink`
             *（见上面 `phase === 'passed'` 与 `fadeTo`）。两支同色系、深浅不同 ⇒ 纸上能一眼
             * 分出「唱过的 / 等着唱的」，而不是两档一模一样的白（旧版两支都是 `palette.ink`）。
             */
            element.style.color = palette.waitInk;
            element.style.opacity = (hero ? palette.waitAlphaHero : palette.waitAlphaBody).toFixed(
              3,
            );
            element.style.textShadow = 'none';
            paintWaitingGlyphs(block, glyphRefs);
          }
        }
      }
      if (running) frame = window.requestAnimationFrame(tick);
    };
    // 页面不可见时停掉循环，可见时按当前 positionMs 重新对齐再继续（重置 last，不累积时间差跳字）。
    const startLoop = (): void => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    const stopLoop = (): void => {
      running = false;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') stopLoop();
      else startLoop();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    startLoop();
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopLoop();
    };
  }, [
    activeBlock,
    clock,
    fontFamily,
    outroActive,
    outroScale,
    plan,
    reduced,
    theme.animationIntensity,
    viewportHeight,
    viewportWidth,
    visible,
    viewBlock,
    tuning,
  ]);

  if (viewBlock === undefined) return null;

  // 契约：主题根元素带 `data-theme='fume'`（`LyricStage` 的舞台根也有同名属性；
  // 这里再挂一份，让「主题根」自己就能被定位 / 断言）。
  return (
    <div
      className="pi-lyricmood pi-lyricmood--fume"
      data-theme="fume"
      data-mood-theme="fume"
      data-active-index={activeIndex}
      data-view-index={viewIndex}
      /* 第十五轮第 6 条 + 用户 m01402 第 3 条的可判定接缝：`playing` = 正常跟随镜头，
       * `outro-soon` = 歌词还没唱完但整首只剩 ≤5s，`finished` = 歌词已唱完；后两者都会把整张纸
       * 缩小铺满（判据见 `fumeOutroPlan`；`outroActive` 与 rAF 用的是同一个值）。 */
      data-fume-state={outroSoon ? 'outro-soon' : outroActive ? 'finished' : 'playing'}
      ref={rootRef}
      style={
        {
          '--pi-fume-paper-width': `${plan.paperWidth}px`,
          '--pi-fume-paper-height': `${plan.paperHeight}px`,
          // 祖先注入的歌曲色优先；解析不到时才是 palette 原值。
          '--pi-fume-primary': paint.primary,
          '--pi-fume-accent': paint.accent,
        } as CSSProperties
      }
    >
      <div
        className="pi-lyricfume__world"
        ref={worldRef}
        style={{ width: `${plan.paperWidth}px`, height: `${plan.paperHeight}px` }}
      >
        {visible.map((block) => (
          <FumeBlockView
            key={`${block.index}-${block.x}-${block.y}`}
            block={block}
            registerBlock={(index, element) => {
              blockRefs.current[index] = element;
            }}
            registerGlyph={(key, element) => {
              glyphRefs.current[key] = element;
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** 镜头焦点：当前**正在唱的那一颗字素**的中心（用户 m00002 第 1 条）。 */
interface FumeFocus {
  readonly worldX: number;
  readonly worldY: number;
  readonly lineHeightPx: number;
  readonly catchUpMs: number;
  /**
   * 镜头正对着的那颗字素的块内键（`wordIndex:glyphIndex`）。
   * 主题把它写到该字素 span 的 `data-fume-focus` 上（可判定接缝，冒烟探针直接量它）；
   * 量不到字素框时为 `null`（那时焦点退回文字并集中心）。
   */
  readonly glyphKey: string | null;
}

/**
 * 一块歌词「文字实际占位」（世界坐标，与 `FumeBlock.x / y` 同一个坐标系）。
 *
 * **用户 m00002 第 1 条**：块框（`block.width`）是**排版列宽**，文字在框里 `text-align: left`
 * 左对齐 —— hero 块跨两列（`paperWidth` ≈ 1.95 视口宽 ⇒ hero 框 ≈ 0.98 视口宽），短句的文字
 * 只占框左边一小截。拿块框中心当焦点，框居中了、**文字却停在左半屏**。
 */
interface FumeTextBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 一颗字素的时间区间（`FumeGlyph` 的最小投影，供纯函数 `fumeFrontGlyphIndex` 使用）。 */
export interface FumeGlyphSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** 一块歌词的量测结果：文字并集 + 逐字素框（世界坐标）+ 字素时间表 / DOM 键（同序）。 */
interface FumeBlockProbe {
  readonly text: FumeTextBox;
  readonly glyphs: readonly (FumeTextBox | undefined)[];
  readonly spans: readonly FumeGlyphSpan[];
  readonly keys: readonly string[];
}

/**
 * **用户 m00002 第 1 条**：`ms` 时正在唱（= 高亮）的那颗字素在**块内**的序号。
 *
 * 判据 = 「已经开唱、且**最晚**开唱的那一颗」：
 *  · `ms` 落在某颗的 `[startMs, endMs]` 里，当然就是它；
 *  · 词与词之间的空档（前一颗唱完、后一颗还没开唱）继续认**刚唱完**的那颗 —— 镜头要的是
 *    「高亮此刻停在哪儿」，空档里它就停在刚唱完的那颗上；这段时间若退回整句中心，镜头会在
 *    每个词间空档来回弹（旧版按「字素中心」对焦时正是这样抖的，所以第十四轮才改成句中心）。
 *  · `ms` 早于第一颗 ⇒ 返回 0（镜头先架在句首等第一颗开唱）；没有字素 ⇒ 返回 -1。
 *
 * 纯函数：只吃时间表，不碰 DOM，所以「在一句里单调推进、不回头看」这件事可以单测钉住。
 */
export function fumeFrontGlyphIndex(spans: readonly FumeGlyphSpan[], ms: number): number {
  if (spans.length === 0) return -1;
  let index = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (span === undefined) continue;
    if (ms < span.startMs) break;
    index = i;
  }
  return index;
}

/**
 * 镜头焦点（第十四轮第 3 条 + **用户 m00002 第 1 条**）。
 *
 * folia 原版是跟着**打印前沿**一格格推进的纪录片镜头；第十四轮按用户当时的要求改成「句中心」，
 * 但**用户 m00002 第 1 条**的措辞是「镜头中心跟随**高亮的字**移动，**始终**使其位于窗口中心」——
 * 高亮在句内是会移动的（打印前沿一颗颗往前爬），句中心是死的。所以焦点回到**正在唱的那颗字素**
 * 的中心（`fumeFrontGlyphIndex` → `probeOf` 量出来的逐字素框），横纵都跟着它走。
 *
 * 字素框量不到（还没挂载 / 还没布局）时退回**文字并集中心**，文字并集也量不到时退回块框中心 ——
 * 两条退路都不会比改造前更差。取景倍率只吃 `lineHeightPx`（= `block.lineHeightPx × 1.34`，
 * 与 `estimateRowCount` 的行距同源），与焦点落在块内哪个点无关。
 * `catchUpMs` 仍是本句时长，喂给弹簧强度（唱得久的句子镜头跟得更缓）。
 */
function resolveFocus(
  activeBlock: FumeBlock | undefined,
  viewBlock: FumeBlock | undefined,
  probeOf: (block: FumeBlock) => FumeBlockProbe | undefined,
  ms: number,
): FumeFocus | undefined {
  const block = activeBlock ?? viewBlock;
  if (block === undefined) return undefined;
  const lineHeightPx = block.lineHeightPx * 1.34;
  const probe = probeOf(block);
  if (probe === undefined) {
    return {
      worldX: block.x + block.width * 0.5,
      worldY: block.y + block.height * 0.5,
      lineHeightPx,
      catchUpMs: block.lineDurationMs,
      glyphKey: null,
    };
  }
  const index = fumeFrontGlyphIndex(probe.spans, ms);
  const glyph = index >= 0 ? probe.glyphs[index] : undefined;
  if (glyph === undefined) {
    return {
      worldX: probe.text.left + probe.text.width * 0.5,
      worldY: probe.text.top + probe.text.height * 0.5,
      lineHeightPx,
      catchUpMs: block.lineDurationMs,
      glyphKey: null,
    };
  }
  /*
   * **用户 m00002 第 1 条（第二遍）**：「镜头移动是平滑的，而不是现在这样顿挫的」。
   *
   * 上一版把焦点取在**那颗字的框中心**上 —— 那是一条**阶梯**：每开唱一颗字，目标就整格跳一个字宽
   *（实测本曲 `fontPx ≈ 24` × `scale 2.2` ≈ 53px），弹簧只能一格一格地追，看起来就是一顿一顿。
   *
   * 改成对**打印前沿**取景：焦点在那颗字的框里从**左缘线性走到右缘**（`progress` = 这颗字唱到哪儿）。
   * 于是一条句子里目标是**连续单调**的（每颗字正好推进一个字宽，接缝处前后一致、不跳），
   * 镜头变成匀速平移 —— 这正是 folia 原版「跟着打印前沿推进的纪录片镜头」的语义。
   * 代价是高亮的字相对画面中心会有**半个字以内**的偏置（前沿在字的前半时字身偏右、后半时偏左），
   * 这比「一格一跳」明显得多地更像「平滑地跟着高亮走」。
   */
  const span = probe.spans[index];
  const startMs = span?.startMs ?? ms;
  const spanMs = Math.max((span?.endMs ?? ms) - startMs, 1);
  const progress = clamp((ms - startMs) / spanMs, 0, 1);
  return {
    worldX: glyph.left + glyph.width * progress,
    worldY: glyph.top + glyph.height * 0.5,
    lineHeightPx,
    catchUpMs: block.lineDurationMs,
    glyphKey: probe.keys[index] ?? null,
  };
}

/** 当前正在打印的字素在块内的 `wordIndex:glyphIndex` 键。 */
function resolveFrontKey(block: FumeBlock | undefined, ms: number): string | undefined {
  if (block === undefined) return undefined;
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const glyph = clump.glyphs[index];
      if (glyph !== undefined && ms >= glyph.startMs && ms <= glyph.endMs) {
        return `${block.index}:${clump.wordIndex}:${index}`;
      }
    }
  }
  return undefined;
}

/**
 * 句内「已经唱过」的那颗字的落点色：主题高亮色按 `p^1.35` 逐渐淡向 `palette.fadeTo`。
 *
 * **用户 m06476 第 2 条**：当前句里进度**之前**的部分要回到原色、进度**还没到**的部分才有颜色。
 * **用户 m00002 第 1 条 + m00380**：这里就是「高亮左边的歌词」（听起来已经唱过的那半句）——
 * `fadeTo === ink`（暗档白 / 亮档对比度兜底后的墨色）⇒ 唱过就真的回常态原色，与参考图一致；
 * 那支粉只留给「还没到」的 `pending` / `lead`。`mixColor` 里的 `t` 被夹到 `[0, 1]`，
 * 所以 `TRAIL_MIX_FLOOR + p * TRAIL_MIX_SPAN`（p=1 时 1.10）正好落在 `fadeTo`，不会过冲。
 */
export function fumeTrailColor(clumpColor: string, palette: FumePaint, p: number): string {
  return mixColor(
    mixColor(clumpColor, 'rgb(0, 0, 0)', ACTIVE_DARK_MIX),
    palette.fadeTo,
    TRAIL_MIX_FLOOR + p * TRAIL_MIX_SPAN,
  );
}

/**
 * 逐字素打印：未唱 / 前沿 / 打印中 / colour trail。
 *
 * 颜色分三段：**未唱到**是恒定的一支**实体暗色** `pending`（**用户第 5 轮第 1 条**：播放头右边
 * **不许**有颜色渐变，整段一支色、满亮度，旧写法那道 `lead → pending` 的主题色坡早撤掉了）；
 * **正在唱**从 `pending` 混向深色字身（`ACTIVE_DARK_MIX`，m06899 轮把 `'#000000'` 改成
 * `'rgb(0, 0, 0)'` 之后才真的生效）；**唱过**由 `fumeTrailColor` 逐渐淡回 `palette.fadeTo`
 *（用户 m06476 第 2 条：进度之前的回到原色）。
 */

function paintActiveGlyphs(
  block: FumeBlock,
  ms: number,
  activeKey: string | undefined,
  palette: FumePaint,
  glowBoost: number,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
  glowCache: Map<string, number>,
  /**
   * **用户 m00002 第 1 条（第二遍）**：褪色速率倍率（`FUME_TRAIL_SPEED_*`）——
   * 镜头走得快就褪得快。`1` = 基准速度（等于加倍率之前的行为）。
   */
  trailRate: number,
  /** **用户 m00380**：把 `clump.color`（可能是 `var()` 链）落成 `rgb()`，否则下面的混色整段失效。 */
  colorOf: (raw: string) => string,
): void {
  const waitAlpha = block.hero ? palette.waitAlphaHero : palette.waitAlphaBody;
  const fullAlpha = block.hero ? 0.985 : 0.92;
  // **用户 m00002 第 1 条（第二遍）**：「褪色速度随镜头移动速度有所变化」⇒ 时长除以速率倍率
  //（倍率 > 1 = 镜头走得比基准快 = 这段 trail 更快跑完）。夹取在 `FUME_TRAIL_SPEED_MIN/MAX` 里做过，
  // 所以这里只需保证不为 0/负（除零会让 `p` 变成 Infinity）。
  const trailDurationSec =
    clamp(
      (block.lineDurationMs / 1000) * (block.hero ? TRAIL_RATIO_HERO : TRAIL_RATIO_BODY),
      TRAIL_DURATION_MIN,
      TRAIL_DURATION_MAX,
    ) / clamp(trailRate, 0.01, 10);
  for (const clump of block.words) {
    // **用户 m00380**：这一坨词的色先落成 `rgb()`（`var()` 链会让下面每个 `mixColor` 直接失效，
    // 唱过的字就永远停在主题原色上、回不到 `palette.fadeTo`）。
    const clumpColor = colorOf(clump.color);
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const glyph = clump.glyphs[index];
      if (glyph === undefined) continue;
      const key = `${block.index}:${clump.wordIndex}:${index}`;
      const element = glyphRefs.current[key];
      if (element === null || element === undefined) continue;
      const span = Math.max(glyph.endMs - glyph.startMs, 1);
      const raw = clamp(ms - glyph.startMs, 0, span) / span;
      if (ms < glyph.startMs) {
        /*
         * **用户第 5 轮第 1 条**（原话：「高亮字左边的歌词部分颜色褪去，右边的歌词部分保持一个
         * 暗淡的颜色」）：这一档是「高亮句里进度未到的部分」，也就是参考图上**右边**那些还在等的字。
         *
         * 上一版（第 4 轮）这里是一支**中性浅色**（`waitInk`）× 恒定 0.44 不透明度。不抢高亮做到了，
         * 但半透明会把封面底色放上来：用户图 1 里右边那截发粉，量出来前 15% 亮像素
         * R=205/G=166/B=164，就是封面色 —— 这不是「暗淡的颜色」，是「洗掉的透明」。
         *
         * 现在：**一支实体暗色 `pending`**（主题色往底色里混 `LEAD_TINT_MIX`）、
         * **满不透明度**、整段**没有任何渐变** —— 右边只负责「看得清下一句、而且是有色的」，
         * 亮度与饱和度都让给高亮那颗字（目标图：右侧亮度 ≈ 左侧的 0.52、饱和度反而更高）。
         */
        element.style.opacity = '1';
        element.style.color = palette.pending;
        element.style.textShadow = 'none';
        continue;
      }
      const eased = easeOutCubic(clamp(raw + PRINT_LEAD, 0, 1));
      const isFront = ms <= glyph.endMs || activeKey === key;
      // 颜色：打印前沿固定亮 0.82，其余按 eased 从 waitAlpha 升到满亮度。
      const frontAlpha = isFront ? PRINT_FRONT_ALPHA : mixNumber(waitAlpha, fullAlpha, eased);
      const trailSec = (ms - glyph.endMs) / 1000;
      let fill: string;
      // 唱过之后**辉光也要跟着收回**：只把颜色淡回原色、却留着那圈主题色光晕，看上去仍然「没回原色」——
      // **用户 m06476 第 2 条**要的是「进度之前的歌词部分回到原色」，所以辉光随 colour trail 一起淡出。
      let trailFade = 1;
      // **用户 m00002 第 1 条（第二遍）**：暗底上「唱过」那段是纯白，比高亮那支饱和色还刺眼
      //（用户：「在暗色模式下太亮了」）⇒ 随 colour trail 把**亮度**也压到 `palette.passedDim`。
      // 只动不透明度、不动色相：落点仍是那个中性常态色，用户上一轮要的「褪回原色」不变，
      // 「唱过的字与还没唱到的字同色」也继续成立（冒烟那条判据量的就是颜色）。亮档 `passedDim = 1`。
      let trailDim = 1;
      if (trailSec <= 0) {
        // **用户第 5 轮第 1 条**：起笔色 = 播放头右边那一整段的**同一支**实体暗色（`palette.pending`），
        // 再随 `eased` 走到实心主题色（`SING_DEEP_SPAN`）。两档共用一支色 ⇒「还没轮到我（暗）→
        // 轮到我（亮、实）」是一条连续曲线，播放头扫到哪颗字，那颗字就在那里开始变亮。
        const hotDeep = mixColor(clumpColor, 'rgb(0, 0, 0)', ACTIVE_DARK_MIX);
        fill = mixColor(palette.pending, hotDeep, SING_DEEP_SPAN * eased);
      } else {
        // 唱过之后：主题色按 `p^1.35` **逐渐**淡向常态色（用户第 4 条「颜色是逐渐淡去」）。
        // **用户 m00002 第 1 条（第二遍）**：时长放回 `0.55~1.35s`（`TRAIL_DURATION_MIN/MAX`）——
        // 上一版压到 0.2~0.45s，用户说「高光左边的渐变褪色太快」；指数未动。落点色两种底色都是
        // `fadeTo === ink`（暗档白 / 亮档对比度兜底后的墨色）⇒ 句内**已经唱过**的部分（参考图里
        // 高亮**左边**那半句）真的回到原色，只有「进度未到」的部分留在 `pending` / `lead` 那支粉上
        //（**用户 m06476 第 2 条** + **m00380**）。
        const p = clamp(trailSec / trailDurationSec, 0, 1) ** TRAIL_EXPONENT;
        fill = fumeTrailColor(clumpColor, palette, p);
        trailFade = 1 - p;
        trailDim = mixNumber(1, palette.passedDim, p);
      }
      element.style.opacity = (frontAlpha * trailDim).toFixed(3);
      element.style.color = fill;
      // 辉光：`(4 + fontPx × 0.22) × eased × boost × trailFade`，颜色 `activeColor@(0.4 + eased × 0.44)`。
      // `trailFade` = 唱过之后随 colour trail 一起收回（用户 m06476 第 2 条：回原色就要连光晕一起收）。
      const glow =
        (GLYPH_GLOW_BASE + block.fontPx * GLYPH_GLOW_PER_FONT) * eased * glowBoost * trailFade;
      const cached = glowCache.get(key);
      if (cached === undefined || Math.abs(cached - glow) > 0.02) {
        glowCache.set(key, glow);
        element.style.textShadow =
          glow <= 0.05
            ? 'none'
            : `0 0 ${glow.toFixed(2)}px ${glowColor(clumpColor, GLYPH_GLOW_ALPHA_FLOOR + eased * GLYPH_GLOW_ALPHA_SPAN)}`;
      }
    }
  }
}

/** 唱过的块：字素回到 inherit，亮度交给块级 opacity。 */
function paintPassedGlyphs(
  block: FumeBlock,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
  glowCache: Map<string, number>,
): void {
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const key = `${block.index}:${clump.wordIndex}:${index}`;
      const element = glyphRefs.current[key];
      if (element === null || element === undefined) continue;
      glowCache.delete(key);
      element.style.opacity = '1';
      element.style.color = 'inherit';
      element.style.textShadow = 'none';
    }
  }
}

/** 还没唱到的块：字素全部回到 inherit。 */
function paintWaitingGlyphs(
  block: FumeBlock,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
): void {
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const element = glyphRefs.current[`${block.index}:${clump.wordIndex}:${index}`];
      if (element === null || element === undefined) continue;
      element.style.opacity = '1';
      element.style.color = 'inherit';
      element.style.textShadow = 'none';
    }
  }
}
