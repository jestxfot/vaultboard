import { createSignal, onCleanup } from 'solid-js';
import type { PerfMonitor, PerfSnapshot } from '../perf/monitor.ts';
import type { BoardView, ViewStats } from '../render/BoardView.ts';

/** Счётчик в углу. Обновляется 4 раза в секунду, а не каждый кадр, чтобы сам не мешать замеру. */
export function PerfOverlay(props: { perf: PerfMonitor; view: BoardView }) {
  const [snap, setSnap] = createSignal<PerfSnapshot>(props.perf.snapshot());
  const [stats, setStats] = createSignal<ViewStats>(props.view.stats);
  const timer = setInterval(() => {
    setSnap(props.perf.snapshot());
    setStats(props.view.stats);
  }, 250);
  onCleanup(() => clearInterval(timer));

  const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} мс`);

  return (
    <div class="perf">
      <div>
        <b>{snap().fps === null ? 'покой' : `${snap().fps!.toFixed(0)} кадр/с`}</b>
        <span classList={{ bad: snap().worstFrame > 34 }}> · худший кадр {snap().worstFrame.toFixed(0)} мс</span>
      </div>
      <div>процессор: {ms(snap().cpuAvg)} (макс {ms(snap().cpuMax)})</div>
      <div classList={{ bad: (snap().latencyMax ?? 0) > 34 }}>
        ввод → кадр: {ms(snap().latencyAvg)} (макс {ms(snap().latencyMax)})
      </div>
      <div>
        объектов {stats().total} · видно {stats().visible} · вблизи {stats().near} · текстов {stats().labels}
        {stats().queued ? ` · в очереди ${stats().queued}` : ''}
      </div>
    </div>
  );
}
