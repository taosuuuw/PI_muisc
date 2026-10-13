/**
 * 凝彩（tempera）**构图目录**的自查（长期保留，`pnpm test` 的默认 include 会自动收进来）。
 *
 * 这份清单是「按观感逼近 folia」的对照表：少抄一条、抄错一条、族划分错了，
 * 后面做 program 编译与绘制时就会悄悄跑偏，所以这里用一份**独立抄录**的原始顺序
 * （folia `tempera/types.ts` 的 `TEMPERA_SHOT_KINDS`）逐条比对。
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERA_DECOR_MOTIFS,
  TEMPERA_MOODS,
  TEMPERA_PARAGRAPH_BOUNDARIES,
  TEMPERA_PARAGRAPH_KINDS,
  TEMPERA_SHOT_FAMILIES,
  TEMPERA_SHOT_FAMILY_OF,
  TEMPERA_SHOT_KINDS,
  TEMPERA_SHOT_KINDS_BY_FAMILY,
  TEMPERA_TRANSITION_KINDS,
} from './temperaKinds';

/** folia 的 `TEMPERA_SHOT_KINDS` 原始顺序（逐条抄录，作为独立副本比对）。 */
const FOLIA_ORDER = [
  // Splits and grids
  'duo-split',
  'quad-split',
  'tri-column',
  'thirds-stack',
  'checker-quad',
  'corner-wedge',
  'diagonal-halves',
  'cross-axis',
  'offset-halves',
  'stair-blocks',
  'pillar-gap',
  'corner-quad',
  'sliver-stack',
  // Bands
  'band-strip',
  'horizon-band',
  'deep-dive',
  'tone-ramp',
  'double-band',
  'tilt-band',
  'edge-rails',
  'gradient-wall',
  'terrace',
  // Frames and windows
  'frame-window',
  'double-frame',
  'circle-window',
  'ladder-frame',
  'corner-brackets',
  'inset-box',
  'bracket-pair',
  'arch-window',
  'grid-cells',
  'keyhole',
  // Posters and shapes
  'poster-panel',
  'diamond-stack',
  'slash-poster',
  'arrow-wedge',
  'edge-bleed',
  'triangle-mass',
  'ribbon-cross',
  'half-disc',
  'stacked-slabs',
  'wedge-pair',
  // Sparse fields
  'quiet-line',
  'starfield-dots',
  'ripple-lines',
  'hair-grid',
  'margin-rule',
  'dot-drift',
  'arc-sweep',
  'blank-page',
  // Cinema mattes
  'cinema-scope',
  'cinema-wide',
  'cinema-academy',
  'cinema-square',
  'cinema-portrait',
  'cinema-tall',
  'cinema-twin',
  // Rounded shapes
  'bubble-drift',
  'cloud-window',
  'heart-burst',
  'sparkle-field',
  'petal-arc',
  'scallop-band',
  'ribbon-loop',
  'round-plate',
  'halo-burst',
  // Punched plates
  'iris-hole',
  'slot-rail',
  'punch-row',
  'film-gate',
  'cross-vent',
  'louvre-slats',
  'ring-eye',
  'notch-stack',
  'wedge-gap',
  'dot-sieve',
  // Instrument panels
  'sight-mark',
  'dial-scale',
  'chevron-run',
  'tally-column',
  'grid-focus',
  'axis-caps',
  'strobe-slats',
  'offset-plate',
  'radial-comb',
  'bracket-target',
  // Corridors
  'flow-channel',
  'twin-channel',
  'reed-run',
  'taper-channel',
  'chain-ports',
  'dash-channel',
  'window-run',
  'bridge-span',
  'braid-channel',
  'port-ladder',
  // Brutalist monoliths
  'apex-mass',
  'ziggurat',
  'slab-wall',
  'cantilever',
  'pylon-pair',
  'bunker-slit',
  'plinth-stack',
  'buttress-run',
  'void-core',
  'shear-block',
  // Terrain
  'ridge-line',
  'chasm',
  'overhang',
  'step-well',
  'pier-row',
  'revetment',
  'tower-crop',
  'lintel',
  'rubble-fan',
  'gnomon',
  // Monogatari interstitials
  'monogatari-card',
  'monogatari-rule',
  'monogatari-edge',
  'monogatari-stack',
  'monogatari-flash',
] as const;

/** 每族的条数（folia 的注释分段：13 / 9 / 10 / 10 / 8 / 7 / 9 / 10 / 10 / 10 / 10 / 10 / 5）。 */
const FOLIA_FAMILY_COUNTS: Readonly<Record<string, number>> = {
  split: 13,
  band: 9,
  frame: 10,
  poster: 10,
  sparse: 8,
  cinema: 7,
  charm: 9,
  aperture: 10,
  signal: 10,
  corridor: 10,
  monolith: 10,
  terrain: 10,
  monogatari: 5,
};

describe('tempera 构图目录', () => {
  it('扁平清单与 folia 的原始顺序逐条一致，共 121 条', () => {
    expect(TEMPERA_SHOT_KINDS).toEqual([...FOLIA_ORDER]);
    expect(TEMPERA_SHOT_KINDS).toHaveLength(121);
    expect(FOLIA_ORDER).toHaveLength(121);
  });

  it('没有重复的构图 id', () => {
    expect(new Set(TEMPERA_SHOT_KINDS).size).toBe(TEMPERA_SHOT_KINDS.length);
  });

  it('十三个族都在，且每族条数与 folia 的分段一致', () => {
    expect([...TEMPERA_SHOT_FAMILIES]).toEqual(Object.keys(FOLIA_FAMILY_COUNTS));
    for (const family of TEMPERA_SHOT_FAMILIES) {
      expect(TEMPERA_SHOT_KINDS_BY_FAMILY[family]).toHaveLength(FOLIA_FAMILY_COUNTS[family] ?? -1);
    }
  });

  it('族归类与扁平清单自洽（每条都能查到唯一的族）', () => {
    for (const family of TEMPERA_SHOT_FAMILIES) {
      for (const kind of TEMPERA_SHOT_KINDS_BY_FAMILY[family]) {
        expect(TEMPERA_SHOT_FAMILY_OF[kind]).toBe(family);
      }
    }
    expect(Object.keys(TEMPERA_SHOT_FAMILY_OF)).toHaveLength(TEMPERA_SHOT_KINDS.length);
  });

  it('转场三种、情绪三档、段落六类、边界五种、装饰母题五种', () => {
    expect([...TEMPERA_TRANSITION_KINDS]).toEqual(['block-wipe', 'camera-pan', 'shape-carry']);
    expect([...TEMPERA_MOODS]).toEqual(['quiet', 'neutral', 'loud']);
    expect([...TEMPERA_PARAGRAPH_KINDS]).toEqual([
      'breath',
      'verse',
      'lift',
      'chorus',
      'break',
      'outro',
    ]);
    expect([...TEMPERA_PARAGRAPH_BOUNDARIES]).toEqual([
      'song-start',
      'time-gap',
      'metadata',
      'duration-cap',
      'line-cap',
    ]);
    expect([...TEMPERA_DECOR_MOTIFS]).toEqual([
      'diamonds',
      'hatch-twin',
      'band-cross',
      'poster-diamond',
      'doodle',
    ]);
  });
});
