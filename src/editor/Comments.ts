// Действия с обсуждениями: создать, ответить, поправить, сменить статус и вид, передвинуть булавку.
// Всё идёт через хранилище — значит, отменяется Ctrl+Z и попадает в журнал истории, как любая правка.
import type { BoardStore } from '../model/store.ts';
import type { BoardView } from '../render/BoardView.ts';
import type { CommentMessage, CommentThread, PinShape } from '../model/types.ts';
import { isLine } from '../model/types.ts';

type Point = { x: number; y: number };

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export class Comments {
  private readonly store: BoardStore;
  private readonly view: BoardView;

  constructor(store: BoardStore, view: BoardView) {
    this.store = store;
    this.view = view;
  }

  get threads(): readonly CommentThread[] {
    return this.store.threads;
  }

  get(id: string): CommentThread | undefined {
    return this.store.thread(id);
  }

  /** Где булавка на доске: на объекте — в доле его размера (ездит и тянется вместе с ним), иначе в своей точке. */
  point(t: CommentThread): Point {
    if (t.item) {
      const r = this.view.rectOf(t.item);
      if (r) return { x: r.x + (t.fx ?? 0) * r.w, y: r.y + (t.fy ?? 0) * r.h };
    }
    return { x: t.x, y: t.y };
  }

  /** Обсуждение не видно, если его объект лежит на скрытом слое. */
  isHidden(t: CommentThread): boolean {
    if (!t.item) return false;
    const item = this.store.get(t.item);
    return !!item && this.view.isHidden(item);
  }

  /** Самый верхний объект под точкой (кроме линий) — к нему прицепится булавка. */
  private anchorAt(p: Point): Pick<CommentThread, 'x' | 'y' | 'item' | 'fx' | 'fy'> {
    const under = this.view
      .search({ x: p.x, y: p.y, w: 0, h: 0 }, true)
      .filter((i) => !isLine(i) && p.x >= i.x && p.x <= i.x + i.w && p.y >= i.y && p.y <= i.y + i.h)
      .sort((a, b) => this.store.indexOf(b.id) - this.store.indexOf(a.id))[0];
    const at = { x: round2(p.x), y: round2(p.y) };
    if (!under || isLine(under) || !under.w || !under.h) return at;
    return { ...at, item: under.id, fx: Math.round(((p.x - under.x) / under.w) * 1e4) / 1e4, fy: Math.round(((p.y - under.y) / under.h) * 1e4) / 1e4 };
  }

  private message(text: string, author: string, parent?: string): CommentMessage {
    const m: CommentMessage = { id: newId(), author, time: new Date().toISOString(), text };
    if (parent) m.parent = parent;
    return m;
  }

  create(p: Point, text: string, author: string, status?: string): string {
    const id = newId();
    const thread: CommentThread = { id, ...this.anchorAt(p), messages: [this.message(text, author)] };
    if (status && status !== 'open') thread.status = status;
    this.store.transact('Комментарий', () => this.store.addThread(thread));
    return id;
  }

  /** Ответ в обсуждении; `parent` — ответ на конкретное сообщение (ветка дерева). */
  reply(id: string, text: string, author: string, parent?: string): void {
    this.store.transact('Ответ', () => this.store.updateThread(id, (t) => ({ ...t, messages: [...t.messages, this.message(text, author, parent)] })));
  }

  editMessage(id: string, messageId: string, text: string): void {
    this.store.transact('Правка комментария', () =>
      this.store.updateThread(id, (t) => ({
        ...t,
        messages: t.messages.map((m) => (m.id === messageId && m.text !== text ? { ...m, text, edited: new Date().toISOString() } : m)),
      })),
    );
  }

  /** Сообщение и все ответы на него (вся ветка). */
  branch(t: CommentThread, messageId: string): Set<string> {
    const out = new Set([messageId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of t.messages) {
        if (m.parent && out.has(m.parent) && !out.has(m.id)) {
          out.add(m.id);
          grew = true;
        }
      }
    }
    return out;
  }

  /** Удалить сообщение вместе с ответами на него; удалили первое — уходит всё обсуждение. */
  deleteMessage(id: string, messageId: string): void {
    const t = this.get(id);
    if (!t) return;
    const gone = this.branch(t, messageId);
    if (t.messages[0]?.id === messageId || gone.size >= t.messages.length) {
      this.remove(id);
      return;
    }
    this.store.transact('Удалить ответ', () => this.store.updateThread(id, (x) => ({ ...x, messages: x.messages.filter((m) => !gone.has(m.id)) })));
  }

  remove(id: string): void {
    this.store.transact('Удалить обсуждение', () => this.store.removeThread(id));
  }

  setStatus(id: string, status: string): void {
    this.patch(id, 'Статус', (t) => {
      const next: CommentThread = { ...t, status };
      if (status === 'open') delete next.status;
      return next;
    });
  }

  /** Свой цвет булавки; null — снова цвет статуса. */
  setColor(id: string, color: string | null): void {
    this.patch(id, 'Цвет комментария', (t) => {
      const next = { ...t };
      if (color) next.color = color;
      else delete next.color;
      return next;
    });
  }

  /** Своя форма булавки; null — снова форма статуса. */
  setShape(id: string, shape: PinShape | null): void {
    this.patch(id, 'Форма комментария', (t) => {
      const next = { ...t };
      if (shape) next.shape = shape;
      else delete next.shape;
      return next;
    });
  }

  /** Реакция: поставить или снять свою. */
  toggleReaction(id: string, messageId: string, emoji: string, author: string): void {
    this.patch(id, 'Реакция', (t) => ({
      ...t,
      messages: t.messages.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = { ...(m.reactions ?? {}) };
        const who = reactions[emoji] ?? [];
        const next = who.includes(author) ? who.filter((a) => a !== author) : [...who, author];
        if (next.length) reactions[emoji] = next;
        else delete reactions[emoji];
        const out: CommentMessage = { ...m, reactions };
        if (!Object.keys(reactions).length) delete out.reactions;
        return out;
      }),
    }));
  }

  // ---------- перетаскивание булавки ----------

  beginMove(): void {
    this.store.beginGesture('Передвинуть комментарий');
  }

  /** Булавка под курсором: прицепляется к объекту, над которым её отпустят. */
  move(id: string, p: Point): void {
    this.store.live(() =>
      this.store.updateThread(id, (t) => {
        const at = this.anchorAt(p);
        const next: CommentThread = { ...t, ...at };
        if (!at.item) {
          delete next.item;
          delete next.fx;
          delete next.fy;
        }
        return next;
      }),
    );
  }

  endMove(): void {
    this.store.endGesture();
  }

  private patch(id: string, label: string, fn: (t: CommentThread) => CommentThread): void {
    this.store.transact(label, () => this.store.updateThread(id, fn));
  }
}
