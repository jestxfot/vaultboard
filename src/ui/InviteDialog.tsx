// Приглашения на доску: открыть доступ из интернета (туннель Cloudflare), создать ссылку с ролью,
// поменять роль, отозвать. Пока у доски есть приглашения, она живёт на сервере вживую — все видят правки друг друга.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { type GuestRole, type InvitesInfo, vault } from '../io/vault.ts';

const ROLES: { role: GuestRole; name: string; hint: string }[] = [
  { role: 'edit', name: 'правит', hint: 'может всё на этой доске: двигать, добавлять, удалять, комментировать' },
  { role: 'comment', name: 'комментирует', hint: 'смотрит и оставляет комментарии, доску не меняет' },
  { role: 'view', name: 'смотрит', hint: 'только смотрит, но видит всё вживую' },
];

export function InviteDialog(props: { board: string; title: string; onClose: () => void; onChanged: (shared: string[]) => void }) {
  const [info, setInfo] = createSignal<InvitesInfo | null>(null);
  const [label, setLabel] = createSignal('');
  const [role, setRole] = createSignal<GuestRole>('edit');
  const [siteUrl, setSiteUrl] = createSignal('');
  const [siteEdited, setSiteEdited] = createSignal(false);
  const [error, setError] = createSignal('');
  const [copied, setCopied] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const load = async () => {
    try {
      const i = await vault.invites(props.board);
      setInfo(i);
      if (!siteEdited()) setSiteUrl(i.siteUrl);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  onMount(() => {
    void load();
    // Пока окно открыто — следим за туннелем и за тем, кто на доске.
    const timer = window.setInterval(() => void load(), 1500);
    onCleanup(() => clearInterval(timer));
  });

  const tunnel = () => info()?.tunnel ?? { kind: 'off' as const };
  const act = async (action: 'start' | 'stop' | 'download') => {
    setError('');
    try {
      await vault.tunnel(action);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt('Скопируй ссылку', text);
    }
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const inv = await vault.createInvite(props.board, role(), label());
      setLabel('');
      await load();
      props.onChanged(info()?.shared ?? []);
      if (inv.link) void copy(inv.link, inv.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string, name: string) => {
    if (!window.confirm(`Отозвать приглашение${name ? ` «${name}»` : ''}? Ссылка перестанет работать сразу, гость с ней отключится.`)) return;
    await vault.deleteInvite(id).catch((err: Error) => setError(err.message));
    await load();
    props.onChanged(info()?.shared ?? []);
  };

  const saveSite = async () => {
    setError('');
    try {
      await vault.putSettings({ siteUrl: siteUrl().trim() });
      setSiteEdited(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const others = () => (info()?.peers ?? []).filter((p) => p.role !== 'owner');

  return (
    <div class="quick-back" onPointerDown={() => props.onClose()}>
      <div class="dialog setup invite" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div class="setup-title">Пригласить на «{props.title}»</div>
        <div class="step-note">
          Гости открывают доску по ссылке прямо у тебя: правки видны всем вживую и сохраняются в твои файлы. Работает, пока vaultboard
          запущен на этом компьютере.
        </div>

        <section class="setup-step">
          <div class="step-head small">Доступ из интернета</div>
          <div class="invite-status">
            <span class="status-dot" classList={{ on: tunnel().kind === 'on', bad: tunnel().kind === 'error' }} />
            <span style={{ flex: 1 }}>
              {(() => {
                const t = tunnel();
                switch (t.kind) {
                  case 'on': return <>Открыт: <a href={t.url} target="_blank" rel="noopener">{t.url.replace('https://', '')}</a></>;
                  case 'starting': return 'Открываю…';
                  case 'downloading': return `Скачиваю cloudflared… ${t.percent}%`;
                  case 'missing': return 'Нужна программа cloudflared от Cloudflare (бесплатно, без аккаунта).';
                  case 'error': return `Не вышло: ${t.message}`;
                  default: return 'Закрыт — гости с ссылкой пока не попадут.';
                }
              })()}
            </span>
            <Show when={tunnel().kind === 'on' || tunnel().kind === 'starting'}>
              <button class="soft-btn" onClick={() => void act('stop')}>Закрыть</button>
            </Show>
            <Show when={tunnel().kind === 'off' || tunnel().kind === 'error'}>
              <button class="soft-btn" onClick={() => void act('start')}>Открыть доступ</button>
            </Show>
            <Show when={tunnel().kind === 'missing'}>
              <Show when={info()?.canDownload} fallback={<span class="step-note">Поставь cloudflared (macOS: brew install cloudflared) и нажми ещё раз.</span>}>
                <button class="soft-btn" onClick={() => void act('download')}>Скачать (~60 МБ)</button>
              </Show>
            </Show>
          </div>
          <div class="step-note">
            Туннель Cloudflare даёт временный адрес; он меняется при каждом открытии. Чтобы ссылки не менялись, впиши адрес
            своего опубликованного сайта — сайт сам поведёт гостей к тебе, а когда ты не в сети, покажет опубликованный снимок.
          </div>
          <div class="settings-row">
            <input
              class="setup-input"
              placeholder="https://мой-сайт.vercel.app (необязательно)"
              value={siteUrl()}
              onInput={(e) => {
                setSiteUrl(e.currentTarget.value);
                setSiteEdited(true);
              }}
            />
            <Show when={siteEdited()}>
              <button class="soft-btn" onClick={() => void saveSite()}>Сохранить</button>
            </Show>
          </div>
          <Show when={info()?.siteUrl && !info()?.siteDir}>
            <div class="step-note bad">Папка сайта не выбрана — сайт не узнает, куда вести гостей. Опубликуй доску хотя бы раз.</div>
          </Show>
        </section>

        <section class="setup-step">
          <div class="step-head small">Новое приглашение</div>
          <div class="settings-row">
            <input class="setup-input" placeholder="Для кого (Маша, команда канала…)" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
            <select class="ctx-select" value={role()} onChange={(e) => setRole(e.currentTarget.value as GuestRole)} title={ROLES.find((r) => r.role === role())?.hint}>
              <For each={ROLES}>{(r) => <option value={r.role}>{r.name}</option>}</For>
            </select>
            <button class="setup-start" disabled={busy()} onClick={() => void create()}>Создать ссылку</button>
          </div>
          <div class="step-note">Гость {ROLES.find((r) => r.role === role())?.hint}. Ссылка — как ключ: кто её получил, тот и войдёт.</div>
        </section>

        <Show when={info()?.invites.length}>
          <section class="setup-step">
            <div class="step-head small">Приглашения на эту доску</div>
            <For each={info()!.invites}>
              {(inv) => (
                <div class="invite-row">
                  <span class="invite-label" title={inv.label}>
                    {inv.label || 'Без подписи'} <small>· {new Date(inv.created).toLocaleDateString('ru-RU')}</small>
                  </span>
                  <select class="ctx-select" value={inv.role} onChange={(e) => void vault.updateInvite(inv.id, { role: e.currentTarget.value as GuestRole }).then(load)}>
                    <For each={ROLES}>{(r) => <option value={r.role}>{r.name}</option>}</For>
                  </select>
                  <Show
                    when={inv.link}
                    fallback={<span class="step-note" title="Открой доступ из интернета или впиши адрес сайта">нет адреса</span>}
                  >
                    <button class="soft-btn" onClick={() => void copy(inv.link!, inv.id)}>{copied() === inv.id ? 'Скопировано' : 'Копировать ссылку'}</button>
                  </Show>
                  <button class="soft-btn danger" onClick={() => void revoke(inv.id, inv.label)}>Отозвать</button>
                </div>
              )}
            </For>
          </section>
        </Show>

        <Show when={others().length}>
          <div class="step-note">
            Сейчас на доске: <For each={others()}>{(p, i) => <><b style={{ color: p.color }}>{p.name}</b>{i() < others().length - 1 ? ', ' : ''}</>}</For>
          </div>
        </Show>
        <Show when={error()}>
          <div class="step-note bad">{error()}</div>
        </Show>
        <div class="step-note">
          Пока у доски есть приглашения, она сохраняется через сервер вживую (и у тебя тоже), а Ctrl+Z отменяет только твои правки
          текущего сеанса. Отзовёшь все приглашения — доска снова станет обычной.
        </div>
        <div class="setup-foot">
          <span class="step-note" />
          <button class="soft-btn" onClick={() => props.onClose()}>Готово</button>
        </div>
      </div>
    </div>
  );
}
