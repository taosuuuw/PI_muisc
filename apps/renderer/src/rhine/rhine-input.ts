import { DRAG_ACTIVE_PX, DRAG_MOVE_PX, WHEEL_MAX_STEPS, WHEEL_STEP, WHEEL_WINDOW_MS } from './rhine-constants';

/**
 * 阵列的指针输入：**自由平面拖拽**（不是横竖二选一）+ 松手惯性 + 滚轮切档。
 *
 * 做法与参考一致（SOURCE: `RhineLabUI src/archive-drag.ts:18-92` 与 `src/scene.ts:1151-1191`）：
 * 1. 起手时把相机当前的两条投影轨道（列方向 / 行方向在世界里各是一个向量）投影到屏幕，
 *    组成 2×2 矩阵并求逆 ⇒ 之后**任意方向的屏幕位移**都能被分解成「走几列 + 走几行」；
 * 2. 位移小于 `DRAG_ACTIVE_PX` 不算拖动（留着给点击）；超过 `DRAG_MOVE_PX` 记「这一下是拖动」；
 * 3. 松手速度取最近 120ms 的采样（反转时重新取样，避免一个来回被平均成 0）；
 * 4. 滚轮按累计 100 触发一档、单次最多 3 档、同向 180ms 内才累计。
 *
 * 这一层**不碰 DOM**：屏幕坐标由调用方喂进来，投影矩阵也由调用方算好。
 */

export interface RhineDragVector {
  x: number;
  y: number;
}

/** 相机两条轨道在屏幕上的方向（每帧起手时采样一次，这一次手势内固定）。 */
export interface RhineDragProjection {
  lane: RhineDragVector;
  row: RhineDragVector;
}

export interface RhineDragValue {
  lane: number;
  row: number;
}

interface Sample {
  value: RhineDragValue;
  time: number;
}

export class RhineDrag {
  active = false;
  moved = false;
  value: RhineDragValue = { lane: 0, row: 0 };

  private startX = 0;
  private startY = 0;
  private pointerX = 0;
  private pointerY = 0;
  private inverse: RhineDragProjection | null = null;
  private samples: Sample[] = [];
  private lastMotion = -Infinity;
  private motionDirection: RhineDragVector = { x: 0, y: 0 };

  start(x: number, y: number, projection: RhineDragProjection, time: number): void {
    this.active = false;
    this.moved = false;
    this.startX = x;
    this.startY = y;
    this.pointerX = x;
    this.pointerY = y;
    this.value = { lane: 0, row: 0 };
    this.samples = [{ value: this.value, time }];
    this.lastMotion = -Infinity;
    this.motionDirection = { x: 0, y: 0 };
    const { lane, row } = projection;
    const determinant = lane.x * row.y - row.x * lane.y;
    const area = Math.hypot(lane.x, lane.y) * Math.hypot(row.x, row.y);
    // 两条轨道在屏幕上几乎平行时（投影退化成一条线）不接管手势，免得除出个天文数字。
    this.inverse =
      Number.isFinite(area) && area > 0 && Math.abs(determinant) > area * 0.001
        ? {
            lane: { x: row.y / determinant, y: -row.x / determinant },
            row: { x: -lane.y / determinant, y: lane.x / determinant },
          }
        : null;
  }

  move(x: number, y: number, time: number): void {
    const dx = x - this.startX;
    const dy = y - this.startY;
    if (Math.hypot(dx, dy) > DRAG_MOVE_PX) this.moved = true;
    if (this.inverse === null) return;
    if (!this.active && Math.hypot(dx, dy) < DRAG_ACTIVE_PX) return;
    this.active = true;
    const value: RhineDragValue = {
      lane: dx * this.inverse.lane.x + dy * this.inverse.lane.y,
      row: dx * this.inverse.row.x + dy * this.inverse.row.y,
    };
    const previous = this.samples[this.samples.length - 1];
    if (previous !== undefined) {
      const delta = { x: x - this.pointerX, y: y - this.pointerY };
      if (Math.hypot(delta.x, delta.y) > 1e-9) {
        this.lastMotion = time;
        // 掉头就重新开始估速度，不去平均一个来回。
        if (delta.x * this.motionDirection.x + delta.y * this.motionDirection.y < 0) {
          this.samples = [previous];
        }
        this.motionDirection = delta;
      }
    }
    this.pointerX = x;
    this.pointerY = y;
    this.value = value;
    const tail = this.samples[this.samples.length - 1];
    if (tail !== undefined && tail.time === time) this.samples[this.samples.length - 1] = { value, time };
    else this.samples.push({ value, time });
    /*
     * 采样表**原地裁剪**，不再每来一个 pointermove 就 `filter().slice()` 造两个新数组。
     * 高刷鼠标一秒能发上千个 pointermove，那样就是每秒两千次分配 + 几万个元素搬运，
     * 拖动时的 GC 抖动就出在这里（2026-10-17 主人报「拖拽比之前卡」，顺手把这个清掉）。
     * 语义完全一致：只保留最近 120ms、最多 32 个采样。
     */
    let drop = 0;
    while (drop < this.samples.length && time - (this.samples[drop]?.time ?? time) > 120) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
    if (this.samples.length > 32) this.samples.splice(0, this.samples.length - 32);
  }

  /** 松手速度（格/秒）。SOURCE: `archive-drag.ts:76-92`。 */
  releaseVelocity(time: number, reduced: boolean): RhineDragValue {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (
      reduced ||
      first === undefined ||
      last === undefined ||
      time - this.lastMotion > 80 ||
      last.time - first.time < 8
    ) {
      return { lane: 0, row: 0 };
    }
    const scale = 1000 / (last.time - first.time);
    return {
      lane: (last.value.lane - first.value.lane) * scale,
      row: (last.value.row - first.value.row) * scale,
    };
  }
}

/**
 * 滚轮累计器：把一串 wheel 事件折成「切了几档、往哪个方向」。
 * SOURCE: `RhineLabUI src/scene.ts:1164-1182`。
 */
export class RhineWheelAccumulator {
  private total = 0;
  private time = 0;

  /** @returns 需要切的档数（可正可负，0 = 这一次不切）。 */
  push(deltaY: number, deltaMode: number, viewportHeight: number, now: number): number {
    const unit = deltaMode === 1 ? 40 : deltaMode === 2 ? viewportHeight : 1;
    const delta = Math.max(-300, Math.min(300, deltaY * unit));
    if (now - this.time > WHEEL_WINDOW_MS || Math.sign(delta) !== Math.sign(this.total)) this.total = 0;
    this.time = now;
    this.total += delta;
    const steps = Math.min(WHEEL_MAX_STEPS, Math.floor(Math.abs(this.total) / WHEEL_STEP));
    if (steps === 0) return 0;
    const direction = Math.sign(this.total);
    this.total -= direction * steps * WHEEL_STEP;
    return direction * steps;
  }

  reset(): void {
    this.total = 0;
  }
}
