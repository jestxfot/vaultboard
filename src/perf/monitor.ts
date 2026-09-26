// Счётчик производительности: кадры, время кадра, задержка от ввода до кадра.
// Доска рисуется только когда что-то меняется, поэтому паузы длиннее IDLE_GAP — это покой, а не тормоза.

const WINDOW_MS = 2000;
const IDLE_GAP = 250;

export interface PerfSnapshot {
  /** Кадров в секунду, пока доска что-то рисует; null — доска в покое. */
  fps: number | null;
  /** Самый долгий промежуток между кадрами за окно, мс — видно рывки. */
  worstFrame: number;
  /** Работа нашего кода и Pixi за кадр на процессоре, мс. */
  cpuAvg: number;
  cpuMax: number;
  /** От события мыши/колеса до кадра с его результатом, мс. */
  latencyAvg: number | null;
  latencyMax: number | null;
}

export class PerfMonitor {
  private frames: { t: number; cpu: number }[] = [];
  private latencies: { t: number; ms: number }[] = [];
  private pendingInput = Infinity;
  lastCpu = 0;

  /** `timeStamp` события — на тех же часах, что и `performance.now()`. */
  noteInput(timeStamp: number): void {
    if (timeStamp < this.pendingInput) this.pendingInput = timeStamp;
  }

  frameDone(cpu: number): void {
    const now = performance.now();
    this.lastCpu = cpu;
    this.frames.push({ t: now, cpu });
    if (this.pendingInput !== Infinity) {
      this.latencies.push({ t: now, ms: now - this.pendingInput });
      this.pendingInput = Infinity;
    }
    const cutoff = now - WINDOW_MS;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    while (this.latencies.length && this.latencies[0].t < cutoff) this.latencies.shift();
  }

  snapshot(): PerfSnapshot {
    const now = performance.now();
    const f = this.frames;
    let activeTime = 0, activeFrames = 0, worst = 0, cpuSum = 0, cpuMax = 0;
    for (let i = 1; i < f.length; i++) {
      const gap = f[i].t - f[i - 1].t;
      if (gap > IDLE_GAP) continue;
      activeTime += gap;
      activeFrames++;
      worst = Math.max(worst, gap);
    }
    for (const fr of f) {
      cpuSum += fr.cpu;
      cpuMax = Math.max(cpuMax, fr.cpu);
    }
    const recentlyActive = f.length > 1 && now - f[f.length - 1].t < IDLE_GAP;
    const lat = this.latencies.map((l) => l.ms);
    return {
      fps: recentlyActive && activeTime > 0 ? (activeFrames * 1000) / activeTime : null,
      worstFrame: worst,
      cpuAvg: f.length ? cpuSum / f.length : 0,
      cpuMax,
      latencyAvg: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      latencyMax: lat.length ? Math.max(...lat) : null,
    };
  }
}
