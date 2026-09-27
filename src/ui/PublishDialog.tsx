// Публикация доски на сайт: папка сайта, список того, что уйдёт (особо — файлы из других папок базы),
// и кнопка. Сайт — снимок доски: правки на диске попадут на него при следующей публикации.
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { type PublishPlan, type PublishResult, type SiteInfo, type SiteSuggestion, vault } from '../io/vault.ts';
import { FolderPicker } from './FolderPicker.tsx';

const KIND_NAMES: Record<PublishPlan['files'][number]['kind'], string> = {
  board: 'доска', image: 'фото', doc: 'заметки', file: 'файлы', link: 'картинки ссылок', embed: 'вставки в заметках',
};

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function files(n: number): string {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? 'файл' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'файла' : 'файлов'}`;
}

export function PublishDialog(props: { board: string; onClose: () => void; onDone: (text: string) => void }) {
  const [plan, setPlan] = createSignal<PublishPlan | null>(null);
  const [site, setSite] = createSignal<SiteInfo | null>(null);
  const [dir, setDir] = createSignal('');
  const [push, setPush] = createSignal(true);
  const [picking, setPicking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [result, setResult] = createSignal<PublishResult | null>(null);
  const [showOutside, setShowOutside] = createSignal(true);
  const [howto, setHowto] = createSignal(false);
  /** Готовые папки для сайта (найденные сайты, пустые клоны репозиториев, новая папка). */
  const [suggestions, setSuggestions] = createSignal<SiteSuggestion[]>([]);
  const [choosing, setChoosing] = createSignal(false);
  const [gh, setGh] = createSignal(false);
  const [repoName, setRepoName] = createSignal('vaultboard-site');
  const [repoPrivate, setRepoPrivate] = createSignal(true);

  onMount(async () => {
    try {
      const [r, sug] = await Promise.all([vault.publishPlan(props.board), vault.publishSuggest().catch(() => ({ suggestions: [], gh: false }))]);
      setPlan(r.plan);
      setSuggestions(sug.suggestions);
      setGh(sug.gh);
      if (r.site.dir) {
        setSite(r.site);
        setDir(r.site.dir);
      } else if (sug.suggestions.length) {
        // Папка ещё не выбрана — сразу берём лучшую из готовых: остаётся только нажать «Опубликовать».
        await pick(sug.suggestions[0].path);
        setChoosing(sug.suggestions.length > 1);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  });

  const suggestionText = (s: SiteSuggestion) =>
    s.kind === 'site'
      ? `Сайт vaultboard · досок ${s.boards}${s.remote ? ` · ${s.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}` : ''}`
      : s.kind === 'repo'
        ? `Пустой репозиторий${s.remote ? ` · ${s.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}` : ''}`
        : 'Новая папка — появится при публикации';

  const makeRepo = async () => {
    setBusy(true);
    setError('');
    try {
      await vault.createGithubRepo(dir(), repoName(), repoPrivate() ? 'private' : 'public');
      setSite(await vault.siteInfo(dir(), props.board));
      setPush(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (p: string) => {
    setPicking(false);
    setDir(p);
    setResult(null);
    try {
      setSite(await vault.siteInfo(p, props.board));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const inside = createMemo(() => plan()?.files.filter((f) => !f.outside) ?? []);
  const outside = createMemo(() => plan()?.files.filter((f) => f.outside) ?? []);
  const byKind = createMemo(() => {
    const counts = new Map<string, number>();
    for (const f of inside()) counts.set(KIND_NAMES[f.kind], (counts.get(KIND_NAMES[f.kind]) ?? 0) + 1);
    return [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
  });
  const canPush = () => !!site()?.git && !!site()?.remote;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await vault.publish(props.board, dir(), push() && canPush());
      setResult(r);
      setSite(await vault.siteInfo(dir(), props.board));
      props.onDone(`Опубликовано: ${r.title}${r.git ? (r.git.ok ? ' — отправлено на сайт' : ' — git не отправил, см. окно публикации') : ''}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Снять доску с сайта? Её файлы, которые не нужны другим доскам сайта, удалятся из папки сайта. На диске в базе ничего не меняется.')) return;
    setBusy(true);
    setError('');
    try {
      const r = await vault.unpublish(props.board, dir(), push() && canPush());
      setSite(await vault.siteInfo(dir(), props.board));
      setResult(null);
      props.onDone(`Доска снята с сайта (удалено файлов: ${r.removed})${r.git && !r.git.ok ? ' — git не отправил' : ''}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="quick-back" onPointerDown={() => !busy() && props.onClose()}>
      <div class="dialog setup publish" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Show
          when={!picking()}
          fallback={
            <>
              <div class="setup-title">Папка сайта</div>
              <div class="step-note">Пустая папка или клон пустого репозитория GitHub, который подключён к Vercel.</div>
              <FolderPicker start={dir()} onPick={(p) => void pick(p)} onCancel={() => setPicking(false)} />
            </>
          }
        >
          <div class="setup-title">Опубликовать «{plan()?.title ?? props.board}»</div>
          <div class="step-note">
            На сайте доску можно смотреть, приближать, открывать заметки и фото — но не править. Сайт — снимок: новые правки
            попадут туда, когда опубликуешь ещё раз.
          </div>

          <section class="setup-step">
            <div class="step-head small">Папка сайта</div>
            <Show
              when={choosing() || !dir()}
              fallback={
                <div class="settings-row">
                  <span class="settings-path" title={dir()}>{dir()}</span>
                  <button class="soft-btn" onClick={() => setChoosing(true)}>Изменить…</button>
                </div>
              }
            >
              <div class="site-options">
                <For each={suggestions()}>
                  {(s) => (
                    <button
                      class="site-option"
                      classList={{ active: dir().toLowerCase() === s.path.toLowerCase() }}
                      onClick={() => {
                        void pick(s.path);
                        setChoosing(false);
                      }}
                    >
                      <span class="so-kind">{s.kind === 'site' ? '🌐' : s.kind === 'repo' ? '📦' : '✨'}</span>
                      <span class="so-text">
                        <b>{s.path}</b>
                        <small>{suggestionText(s)}</small>
                      </span>
                    </button>
                  )}
                </For>
                <button class="site-option" onClick={() => setPicking(true)}>
                  <span class="so-kind">📁</span>
                  <span class="so-text"><b>Другая папка…</b><small>выбрать самому</small></span>
                </button>
              </div>
            </Show>
            <Show when={site() && dir()}>
              <div class="step-note">
                <Show when={site()!.boards.length} fallback="Сайта здесь ещё нет — он появится при публикации.">
                  На сайте досок: {site()!.boards.length}
                  <Show when={site()!.published}> · эта опубликована {new Date(site()!.published!).toLocaleString('ru-RU')}</Show>
                </Show>
                <br />
                <Show when={site()!.remote} fallback={gh() ? 'Репозитория у папки пока нет — его можно создать здесь же:' : 'Папка не связана с GitHub — выложить её на хостинг нужно будет вручную (или сделай её клоном репозитория, см. ниже).'}>
                  git → {site()!.remote}
                </Show>
              </div>
              <Show when={!site()!.remote && gh()}>
                <div class="settings-row">
                  <input class="setup-input" value={repoName()} onInput={(e) => setRepoName(e.currentTarget.value)} title="Имя репозитория на GitHub" />
                  <select class="ctx-select" value={repoPrivate() ? 'private' : 'public'} onChange={(e) => setRepoPrivate(e.currentTarget.value === 'private')}>
                    <option value="private">закрытый</option>
                    <option value="public">открытый</option>
                  </select>
                  <button class="soft-btn" disabled={busy() || !repoName().trim()} onClick={() => void makeRepo()}>Создать на GitHub</button>
                </div>
                <div class="step-note">Через программу gh, в которую ты уже вошёл. Сайт на Vercel будет открыт всем в любом случае; закрытый репозиторий прячет только историю файлов.</div>
              </Show>
            </Show>
          </section>

          <Show when={plan()} fallback={<div class="step-note">{error() || 'Собираю список файлов…'}</div>}>
            {(p) => (
              <section class="setup-step">
                <div class="step-head small">
                  Что уйдёт на сайт: {files(p().files.length)}, {mb(p().total)}
                </div>
                <div class="step-note">Из папки доски: {files(inside().length)} ({byKind()}).</div>
                <Show when={outside().length}>
                  <div class="publish-outside">
                    <button class="link-btn" onClick={() => setShowOutside(!showOutside())}>
                      {showOutside() ? '▾' : '▸'} Из других папок базы — {files(outside().length)}. Проверь, что их можно показывать всем:
                    </button>
                    <Show when={showOutside()}>
                      <ul>
                        <For each={outside()}>{(f) => <li title={f.path}>{f.path} <span class="muted">· {KIND_NAMES[f.kind]}, {mb(f.size)}</span></li>}</For>
                      </ul>
                    </Show>
                  </div>
                </Show>
                <div class="step-note">
                  Не уйдут: история отмены
                  <Show when={p().comments}>, комментарии ({p().comments})</Show>
                  <Show when={p().hiddenItems}>, объекты скрытых слоёв ({p().hiddenItems})</Show>.
                </div>
                <Show when={p().missing.length}>
                  <div class="step-note bad">Нет на диске ({p().missing.length}): {p().missing.slice(0, 5).join(', ')}{p().missing.length > 5 ? '…' : ''}</div>
                </Show>
              </section>
            )}
          </Show>

          <Show when={canPush()}>
            <label class="switch-row">
              <span class="switch">
                <input type="checkbox" checked={push()} onChange={(e) => setPush(e.currentTarget.checked)} />
                <span class="switch-track" />
              </span>
              <span>Сразу отправить на сайт (git commit и push)</span>
            </label>
          </Show>

          <button class="link-btn" onClick={() => setHowto(!howto())}>{howto() ? '▾' : '▸'} Как выложить на Vercel (один раз)</button>
          <Show when={howto()}>
            <ol class="publish-howto">
              <li>Создай на GitHub пустой репозиторий, например <code>my-boards</code>.</li>
              <li>Склонируй его в пустую папку (<code>git clone …</code>) и выбери эту папку здесь как папку сайта.</li>
              <li>Опубликуй доску с галочкой «Сразу отправить» — файлы уйдут в репозиторий.</li>
              <li>На vercel.com: Add New → Project → выбери репозиторий. Framework — Other, сборку не указывай. Deploy.</li>
            </ol>
            <div class="step-note">Дальше каждая публикация сама обновляет сайт. Большие фото Vercel отдаёт как есть; если их очень много — лимиты бесплатного тарифа могут кончиться.</div>
          </Show>

          <Show when={result()}>
            {(r) => (
              <div class="publish-result">
                Готово: {files(r().files)} на сайте, новых скопировано {r().copied}
                <Show when={r().copiedBytes}> ({mb(r().copiedBytes)})</Show>
                <Show when={r().removed}>, удалено ненужных {r().removed}</Show>.
                <Show when={r().git}>
                  <div classList={{ bad: !r().git!.ok }}>{r().git!.ok ? 'git: отправлено — Vercel обновит сайт через минуту.' : `git не отправил: ${r().git!.output}`}</div>
                </Show>
                <div>
                  <a href={`/api/site/?open=${encodeURIComponent(props.board)}`} target="_blank" rel="noopener">Посмотреть у себя</a>
                </div>
              </div>
            )}
          </Show>
          <Show when={error() && plan()}>
            <div class="step-note bad">{error()}</div>
          </Show>

          <div class="setup-foot">
            <Show when={site()?.published}>
              <button class="soft-btn danger" disabled={busy()} onClick={() => void remove()}>Снять с сайта</button>
            </Show>
            <span class="step-note" />
            <button class="soft-btn" disabled={busy()} onClick={() => props.onClose()}>Закрыть</button>
            <button class="setup-start" disabled={busy() || !plan() || !dir()} onClick={() => void run()}>
              {busy() ? 'Публикую…' : site()?.published ? 'Опубликовать заново' : 'Опубликовать'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
