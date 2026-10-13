/**
 * 凝彩（tempera）**构图数值表**的自查（长期保留，`pnpm test` 的默认 include 会自动收进来）。
 *
 * 这张表是由 `.folia-ref/gen-tempera-profiles.mjs` 从 folia 的同名数据表提取的（脚本与上游源码都不入库）。
 * 提取是一次性的，所以这里要把「提取对了没有」钉死：键集合、条数、情绪分布、装饰开关，
 * 以及每类数值的合理区间 —— 以后谁手改了这张表，这些断言会立刻红。
 */

import { describe, expect, it } from 'vitest';
import { TEMPERA_SHOT_FAMILY_OF, TEMPERA_SHOT_KINDS } from './temperaKinds';
import {
  TEMPERA_SHOT_PROFILES,
  resolveTemperaShotCandidates,
  resolveTemperaShotProfile,
} from './temperaProfiles';

const ALL_KINDS = Object.keys(TEMPERA_SHOT_PROFILES);

describe('tempera 构图数值表', () => {
  it('键集合与构图目录完全一致（121 条，不多不少）', () => {
    expect(ALL_KINDS.sort()).toEqual([...TEMPERA_SHOT_KINDS].sort());
    expect(ALL_KINDS).toHaveLength(121);
  });

  it('情绪分布与 folia 一致：neutral 49 / loud 38 / quiet 34', () => {
    const counts = ALL_KINDS.reduce<Record<string, number>>((acc, kind) => {
      const mood = TEMPERA_SHOT_PROFILES[kind as keyof typeof TEMPERA_SHOT_PROFILES].mood;
      acc[mood] = (acc[mood] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ neutral: 49, loud: 38, quiet: 34 });
  });

  it('只有物语系过场卡（5 条）关掉共用装饰', () => {
    const withoutDecor = ALL_KINDS.filter(
      (kind) => TEMPERA_SHOT_PROFILES[kind as keyof typeof TEMPERA_SHOT_PROFILES].sharedDecor === false,
    );
    expect(withoutDecor).toHaveLength(5);
    for (const kind of withoutDecor) {
      expect(TEMPERA_SHOT_FAMILY_OF[kind as keyof typeof TEMPERA_SHOT_FAMILY_OF]).toBe('monogatari');
    }
  });

  it('每条的排版区域、入场向量、镜头数值都落在合理区间', () => {
    for (const kind of ALL_KINDS) {
      const profile = TEMPERA_SHOT_PROFILES[kind as keyof typeof TEMPERA_SHOT_PROFILES];
      const [cx, cy, w, h] = profile.region;
      expect(cx).toBeGreaterThan(0.1);
      expect(cx).toBeLessThan(0.9);
      expect(cy).toBeGreaterThan(0.1);
      expect(cy).toBeLessThan(0.9);
      expect(w).toBeGreaterThan(0.15);
      expect(w).toBeLessThanOrEqual(1);
      expect(h).toBeGreaterThan(0.1);
      expect(h).toBeLessThanOrEqual(1);
      const [enterX, enterY] = profile.enter;
      expect(Math.abs(enterX)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(enterY)).toBeLessThanOrEqual(2.5);
      const [travel, zoomStart, zoomEnd] = profile.camera;
      expect(travel).toBeGreaterThan(0);
      expect(travel).toBeLessThanOrEqual(0.5);
      expect(zoomStart).toBeGreaterThan(0.8);
      expect(zoomStart).toBeLessThan(1.4);
      expect(zoomEnd).toBeGreaterThan(0.8);
      expect(zoomEnd).toBeLessThan(1.4);
      if (profile.fontScale !== undefined) {
        expect(profile.fontScale).toBeGreaterThan(0.4);
        expect(profile.fontScale).toBeLessThanOrEqual(1.6);
      }
      if (profile.rotation !== undefined) {
        expect(Math.abs(profile.rotation)).toBeLessThan(0.3);
      }
    }
  });

  it('按情绪档取候选构图：命中对应档，且三档合起来就是全部 121 条', () => {
    const quiet = resolveTemperaShotCandidates(['quiet']);
    const neutral = resolveTemperaShotCandidates(['neutral']);
    const loud = resolveTemperaShotCandidates(['loud']);
    expect(quiet).toHaveLength(34);
    expect(neutral).toHaveLength(49);
    expect(loud).toHaveLength(38);
    expect(new Set([...quiet, ...neutral, ...loud]).size).toBe(121);
    // 换气段只取 quiet，副歌取 neutral + loud —— 两种组合都得非空，否则编译期会退化成空候选。
    expect(resolveTemperaShotCandidates(['quiet']).length).toBeGreaterThan(0);
    expect(resolveTemperaShotCandidates(['neutral', 'loud'])).toHaveLength(87);
    expect(resolveTemperaShotCandidates([])).toHaveLength(0);
  });

  it('取单条 profile 返回同一个对象（稳定引用，编译期可反复读）', () => {
    expect(resolveTemperaShotProfile('duo-split')).toBe(TEMPERA_SHOT_PROFILES['duo-split']);
    expect(resolveTemperaShotProfile('monogatari-card').sharedDecor).toBe(false);
  });
});
