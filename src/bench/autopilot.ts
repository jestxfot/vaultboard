// Автопилот замера: сам двигает и зумит доску, меряет кадры по фазам.
import type { BoardView, Camera } from '../render/BoardView.ts';

export interface PhaseResult {
  name: string;
  frames: number;
  fps: number;
  /** 95-й перцентиль промежутка между кадрами, мс. */
  p95: number;
  /** Самый долгий промежуток, мс. */
  worst: number;
  /** Среднее время работы кадра на процессоре, мс. */
  cpuAvg: number;
  visibleAvg: number;
}

interface Phase {
  name: string;
  ms: number;
  setup: () => Camera;
  step: (p: number, base: Camera) => Partial<Camera>;
}

const WARMUP_MS = 400;

function percentile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
}

export async function runAutopilot(view: BoardView, onPhase?: (name: string) => void): Promise<PhaseResult[]> {
  const b = view.boardBounds;
  const fitted = (): Camera => {
    view.fitAll(40);
    return { ...view.cam };
  };
  const phases: Phase[] = [
    {
      name: 'Вся доска на экране',
      ms: 3000,
      setup: fitted,
      step: (p, base) => ({ x: base.x + Math.sin(p * Math.PI * 4) * 150 }),
    },
    {
      name: 'Панорама на рабочем масштабе',
      ms: 4000,
      setup: () => {
        view.setCamera({ zoom: 0.6, x: -b.x * 0.6, y: -b.y * 0.6 });
        return { ...view.cam };
      },
      step: (p, base) => ({ x: base.x - p * b.w * 0.6 * 0.8, y: base.y - p * b.h * 0.6 * 0.8 }),
    },
    {
      name: 'Зум туда-обратно',
      ms: 4000,
      setup: fitted,
      step: (p, base) => {
        const { w, h } = view.screen;
        const zoom = Math.exp(Math.log(base.zoom) + (Math.log(1.5) - Math.log(base.zoom)) * (0.5 - 0.5 * Math.cos(p * Math.PI * 4)));
        const k = zoom / base.zoom;
        return { zoom, x: w / 2 - (w / 2 - base.x) * k, y: h / 2 - (h / 2 - base.y) * k };
      },
    },
  ];

  const results: PhaseResult[] = [];
  for (const phase of phases) {
    onPhase?.(phase.name);
    const base = phase.setup();
    const result = await new Promise<PhaseResult>((resolve) => {
      let start = -1;
      let last = -1;
      const gaps: number[] = [];
      const cpu: number[] = [];
      const visible: number[] = [];
      view.driver = (t) => {
        if (start < 0) start = t;
        const elapsed = t - start;
        if (elapsed > WARMUP_MS) {
          if (last >= 0) gaps.push(t - last);
          cpu.push(view.lastCpu);
          visible.push(view.stats.visible);
        }
        last = t;
        const p = Math.min(1, elapsed / phase.ms);
        view.setCamera(phase.step(p, base));
        if (p >= 1) {
          view.driver = null;
          const sorted = [...gaps].sort((x, y) => x - y);
          const total = gaps.reduce((s, g) => s + g, 0);
          resolve({
            name: phase.name,
            frames: gaps.length,
            fps: total ? (gaps.length * 1000) / total : 0,
            p95: percentile(sorted, 0.95),
            worst: sorted[sorted.length - 1] ?? 0,
            cpuAvg: cpu.reduce((s, c) => s + c, 0) / (cpu.length || 1),
            visibleAvg: visible.reduce((s, c) => s + c, 0) / (visible.length || 1),
          });
        }
      };
      view.requestFrame();
    });
    results.push(result);
  }
  return results;
}
