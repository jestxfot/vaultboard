// Обновление прямо в приложении, без участия пользователя.
//
// Вкладка держит один долгий запрос к своему серверу: «сообщи, когда узнаешь о другой версии».
// Сервер сам раз в 3 минуты спрашивает GitHub (условным запросом, не тратя лимит) и отвечает всем вкладкам сразу,
// как только узнал о релизе, — плашка появляется в ту же секунду, без постоянных опросов.
// Оборвался запрос — сервер перезапускается: ждём его и перезагружаем страницу.
// Если это обычная установка и автообновление включено, после минуты без действий приложение само
// сохраняет доску, просит сервер перезапуститься с обновлением и перезагружает страницу, когда он вернётся.
// «Обновить сейчас» — не ждать; «Позже» — не трогать до следующего запуска.
// Сервер может перезапуститься и сам (вкладка брошена надолго) — тогда просто ждём его и перезагружаемся.
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { type UpdateStatus, vault } from '../io/vault.ts';

/** Сколько без действий, чтобы обновиться самому. */
const IDLE_MS = 60_000;

/** Событие «проверь обновления сейчас» — его шлёт щелчок по номеру версии в шапке. */
export const CHECK_UPDATE_EVENT = 'vaultboard:check-update';

export function Updater(props: {
  /** Сохранить всё несохранённое перед перезапуском. */
  beforeRestart: () => Promise<void>;
  /** Сообщить приложению о новой версии (отметка у номера версии в панели). */
  onStatus: (u: UpdateStatus | null) => void;
  /** Короткое сообщение внизу («у тебя последняя версия»). */
  onNotice: (text: string) => void;
  /** Версия, которую сообщил сервер (номер в шапке — по ней, а не только по вшитому при сборке). */
  onVersion?: (current: string) => void;
}) {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  const [hidden, setHidden] = createSignal(false);
  const [postponed, setPostponed] = createSignal(false);
  /** Идёт обновление: текст для экрана ожидания. */
  const [busy, setBusy] = createSignal<string | null>(null);
  let lastInput = Date.now();
  let alive = true;

  /** Долгий запрос за запросом: каждый ответ — свежие новости о версии; обрыв — сервер перезапускается. */
  const listen = async () => {
    let known: string | null = null;
    while (alive && !busy()) {
      try {
        // Первый раз — обычный запрос (узнать версию сразу), дальше — долгие: ответ придёт, когда будут новости.
        const u: UpdateStatus = known === null ? await vault.updateStatus() : await vault.updateWait(known);
        known = u.latest?.tag ?? '';
        props.onVersion?.(u.current);
        setStatus(u.available ? u : null);
        props.onStatus(u.available ? u : null);
      } catch {
        if (!alive || busy()) return;
        setBusy('Сервер перезапускается — наверное, ставит новую версию. Страница перезагрузится сама…');
        waitForServer();
        return;
      }
    }
  };

  /** Ждать, пока сервер снова ответит, и перезагрузить страницу. */
  const waitForServer = () => {
    const started = Date.now();
    const tick = async () => {
      try {
        await vault.updateStatus();
        location.reload();
      } catch {
        if (Date.now() - started > 5 * 60_000) {
          setBusy('Сервер так и не вернулся. Запусти vaultboard.vbs ещё раз — обновление доделается при запуске.');
          return;
        }
        setTimeout(() => void tick(), 1500);
      }
    };
    setTimeout(() => void tick(), 1500);
  };

  const applyNow = async () => {
    const u = status();
    if (!u?.canApply || busy()) return;
    setBusy(`Обновляю vaultboard до ${u.latest!.tag}… Страница перезагрузится сама.`);
    try {
      await props.beforeRestart();
      await vault.applyUpdate();
      waitForServer();
    } catch (err) {
      setBusy(null);
      window.alert(`Не удалось обновиться: ${(err as Error).message}`);
    }
  };

  /** Проверить сейчас (щелчок по номеру версии): спросить GitHub, не дожидаясь фоновой проверки. */
  const checkNow = async () => {
    if (busy()) return;
    props.onNotice('Проверяю обновления…');
    try {
      const u = await vault.updateStatus(true);
      props.onVersion?.(u.current);
      setStatus(u.available ? u : null);
      props.onStatus(u.available ? u : null);
      setHidden(false);
      if (u.available) return;
      if (!u.latest) props.onNotice(`Версия ${u.current}. Релизов на GitHub не нашлось или GitHub не ответил`);
      else if (u.git) props.onNotice(`Версия ${u.current} — последняя. Это копия для разработки: она обновляется через git pull`);
      else props.onNotice(`Версия ${u.current} — последняя`);
    } catch (err) {
      props.onNotice(`Не удалось проверить: ${(err as Error).message}`);
    }
  };

  onMount(() => {
    void listen();
    const onCheck = () => void checkNow();
    window.addEventListener(CHECK_UPDATE_EVENT, onCheck);
    onCleanup(() => window.removeEventListener(CHECK_UPDATE_EVENT, onCheck));
    const onInput = () => { lastInput = Date.now(); };
    // Минута без действий — обновиться самому (если можно, включено и не отложено).
    const idle = setInterval(() => {
      const u = status();
      if (!u?.canApply || !u.enabled || postponed() || busy()) return;
      if (Date.now() - lastInput >= IDLE_MS) void applyNow();
    }, 10_000);
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.addEventListener(ev, onInput, { capture: true, passive: true });
    onCleanup(() => {
      alive = false;
      clearInterval(idle);
      for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.removeEventListener(ev, onInput, { capture: true });
    });
  });

  const text = (u: UpdateStatus) => {
    if (u.git) return ' — у тебя копия из git: обнови через git pull';
    if (!u.canApply) return ' — поставится при следующем запуске vaultboard.vbs';
    if (postponed()) return ' — поставится при следующем запуске';
    if (u.enabled) return ' — обновлюсь сам, когда отвлечёшься на минуту';
    return '';
  };

  return (
    <>
      <Show when={!hidden() && !busy() && status()}>
        {(u) => (
          <div class="update-banner">
            <span>Вышла версия <b>{u().latest!.tag}</b>{text(u())}</span>
            <a href={u().latest!.url} target="_blank" rel="noopener">Что нового</a>
            <Show when={u().canApply}>
              <button class="ub-now" onClick={() => void applyNow()}>Обновить сейчас</button>
              <Show when={u().enabled && !postponed()}>
                <button class="ub-later" onClick={() => setPostponed(true)} title="Не обновляться, пока приложение открыто">Позже</button>
              </Show>
            </Show>
            <button class="ub-close" onClick={() => setHidden(true)} title="Скрыть плашку (отметка у номера версии останется)">×</button>
          </div>
        )}
      </Show>
      <Show when={busy()}>
        <div class="update-overlay">
          <div class="update-box">
            <span class="update-spinner" />
            <div>{busy()}</div>
          </div>
        </div>
      </Show>
    </>
  );
}
