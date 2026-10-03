import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { RECOMMENDED_ACCENTS, hexToHsv, hsvToHex, parseHexColor, type Hsv } from '../lib/accent';
import '../styles/accent-picker.css';

/**
 * 自定义主题色的取色面板（用户第二十二轮第 2 条）。
 *
 * 原话：「点击自定义主题颜色时，在下面出现专门的设置栏，包括图 2 所显示的选色框图，
 * 如图 3 所示的推荐色栏，当前选色显示等。并且要在快捷设置页加上自定义主题色的功能栏」。
 *
 * 图 2 是标准的 HSV 取色器：一块「白 → 纯色」横向渐变叠「透明 → 黑」纵向渐变的**方形画布**，
 * 里面一个圆环手柄；下面一条色相彩虹条，同样是圆环手柄。图 3 是 12 枚圆角「推荐色」。
 * 这一块就照这个结构做，三处都能用（设置页 / 快捷设置卡），所以抽成组件。
 *
 * 交互与键盘（都只改 `onChange` 传出去的颜色，不自己存状态）：
 * - 方块：按下并拖动 = 跟着指针改饱和度/明度；`←→↑↓` 每按一下走 2%；
 * - 色相条：按下并拖动 = 改色相；`←→` 每按一下走 2°；
 * - 推荐色 / 十六进制输入：直接给整枚颜色。
 *
 * 手柄位置与画布底色都从同一份 HSV 推出来（`lib/accent.ts` 的纯函数），
 * 所以「外部改了颜色（点推荐色、填十六进制）」与「面板里拖出来的颜色」永远一致。
 */
export interface AccentPickerProps {
  value: string;
  onChange: (hex: string) => void;
  /** 紧凑档：给快捷设置卡用（去掉十六进制输入那一行之外的内边距与说明）。 */
  compact?: boolean;
}

/** SV 方块的底色：横向 白 → 当前色相的纯色，纵向叠一层 透明 → 黑。 */
function svBackground(hsv: Hsv): string {
  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return [
    'linear-gradient(to top, #000, rgba(0, 0, 0, 0))',
    `linear-gradient(to right, #fff, ${pure})`,
  ].join(', ');
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function AccentPicker({ value, onChange, compact = false }: AccentPickerProps): ReactNode {
  /*
   * 面板自己持有一份 HSV：拖拽过程中若每帧都从 `value` 反推，色相会在灰度色上丢失
   * （纯黑/纯白的色相是 0），手柄会突然跳回红色端。所以只有「外部值不再等于本地面板推出来的
   * 颜色」时才重新采纳外部值（点推荐色、填十六进制、换档位都会走到这一支）。
   */
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [draft, setDraft] = useState<string | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHsv((current) => (hsvToHex(current) === value.toLowerCase() ? current : hexToHsv(value)));
  }, [value]);

  const commit = (next: Hsv): void => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  /** 指针在某个元素内的相对位置（0–1，已夹好）。 */
  const relative = (element: HTMLElement, clientX: number, clientY: number): [number, number] => {
    const box = element.getBoundingClientRect();
    return [
      clamp01((clientX - box.left) / Math.max(1, box.width)),
      clamp01((clientY - box.top) / Math.max(1, box.height)),
    ];
  };

  const pickSv = (event: PointerEvent<HTMLDivElement>): void => {
    const [x, y] = relative(event.currentTarget, event.clientX, event.clientY);
    commit({ ...hsv, s: x, v: 1 - y });
  };

  const pickHue = (event: PointerEvent<HTMLDivElement>): void => {
    const [x] = relative(event.currentTarget, event.clientX, event.clientY);
    commit({ ...hsv, h: x * 360 });
  };

  const svStyle = { background: svBackground(hsv) } as CSSProperties;
  const handleStyle = {
    left: `${(hsv.s * 100).toFixed(2)}%`,
    top: `${((1 - hsv.v) * 100).toFixed(2)}%`,
  } as CSSProperties;
  const hueHandleStyle = { left: `${((hsv.h / 360) * 100).toFixed(2)}%` } as CSSProperties;

  return (
    <div
      className={`pi-accent-picker${compact ? ' pi-accent-picker--compact' : ''}`}
      data-accent-picker="true"
    >
      <div
        ref={svRef}
        className="pi-accent-picker__sv"
        style={svStyle}
        role="slider"
        tabIndex={0}
        aria-label="饱和度与明度"
        aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}% 明度 ${Math.round(hsv.v * 100)}%`}
        data-accent-sv="true"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickSv(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pickSv(event);
        }}
        onKeyDown={(event) => {
          const step = 0.02;
          if (event.key === 'ArrowLeft') commit({ ...hsv, s: clamp01(hsv.s - step) });
          else if (event.key === 'ArrowRight') commit({ ...hsv, s: clamp01(hsv.s + step) });
          else if (event.key === 'ArrowUp') commit({ ...hsv, v: clamp01(hsv.v + step) });
          else if (event.key === 'ArrowDown') commit({ ...hsv, v: clamp01(hsv.v - step) });
          else return;
          event.preventDefault();
        }}
      >
        <span className="pi-accent-picker__ring" style={handleStyle} />
      </div>

      <div
        ref={hueRef}
        className="pi-accent-picker__hue"
        role="slider"
        tabIndex={0}
        aria-label="色相"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        data-accent-hue="true"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickHue(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pickHue(event);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const delta = event.key === 'ArrowLeft' ? -7.2 : 7.2;
          commit({ ...hsv, h: (((hsv.h + delta) % 360) + 360) % 360 });
          event.preventDefault();
        }}
      >
        <span
          className="pi-accent-picker__ring pi-accent-picker__ring--hue"
          style={hueHandleStyle}
        />
      </div>

      <div className="pi-accent-picker__now">
        <span className="pi-accent-picker__label">当前选色</span>
        <span
          className="pi-accent-picker__chip"
          style={{ background: value }}
          data-accent-now="true"
        />
        <input
          type="text"
          className="pi-input pi-accent-picker__hex"
          value={draft ?? value}
          aria-label="主色十六进制值"
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            // 只有完整色值才写出去：边打字边写会把 `#1f9` 这种半截值存下来。
            if (parseHexColor(next) !== null) onChange(next.startsWith('#') ? next : `#${next}`);
          }}
          onBlur={() => setDraft(null)}
        />
      </div>

      <div className="pi-accent-picker__rec">
        <span className="pi-accent-picker__label">推荐色</span>
        <div className="pi-accent-picker__swatches">
          {RECOMMENDED_ACCENTS.map((hex) => (
            <button
              key={hex}
              type="button"
              className="pi-accent-picker__swatch"
              style={{ background: hex }}
              data-accent-swatch={hex}
              data-active={value.toLowerCase() === hex ? 'true' : 'false'}
              aria-label={`推荐色 ${hex}`}
              title={hex}
              onClick={() => onChange(hex)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
