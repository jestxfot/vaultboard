// Поле ввода поверх объекта. Стоит точно на месте надписи, тем же шрифтом и в том же масштабе,
// поэтому при начале и конце правки текст не прыгает. Пока поле открыто, доска свою надпись не рисует.
import type { BoxItem } from '../model/types.ts';
import type { BoardView } from '../render/BoardView.ts';
import { fitFontSize, FONT, labelSpec, lineHeightOf } from '../render/draw.ts';

export type CloseReason = 'escape' | 'tab' | 'ctrlEnter' | 'blur' | 'outside';
export type EditField = 'text' | 'title' | 'label';

/** Что правим: объект доски или место подписи на линии (прямоугольник вокруг середины линии). */
export type EditTarget = BoxItem | { id: string; kind: 'label'; x: number; y: number; w: number; h: number };

export interface TextEditorCallbacks {
  onInput: (value: string) => void;
  onClose: (reason: CloseReason) => void;
}

export class TextEditor {
  private readonly wrap = document.createElement('div');
  private readonly area = document.createElement('textarea');
  private readonly view: BoardView;
  private readonly cb: TextEditorCallbacks;
  private item: EditTarget | null = null;
  private field: EditField = 'text';
  private closing = false;

  constructor(parent: HTMLElement, view: BoardView, cb: TextEditorCallbacks) {
    this.view = view;
    this.cb = cb;
    this.wrap.className = 'text-edit';
    this.area.spellcheck = true;
    this.wrap.appendChild(this.area);
    this.wrap.style.display = 'none';
    parent.appendChild(this.wrap);

    this.area.addEventListener('input', () => {
      this.autosize();
      this.cb.onInput(this.area.value);
    });
    this.area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Оформление выделенного куска текста — прямо markdown-разметкой, как в Obsidian.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyB') return this.wrapKey(e, '**');
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyI') return this.wrapKey(e, '*');
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyH') return this.wrapKey(e, '==');
      if (e.key === 'Escape') this.finish('escape', e);
      else if (e.key === 'Tab' && this.field === 'text') this.finish('tab', e);
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.finish('ctrlEnter', e);
      else if (e.key === 'Enter' && !e.shiftKey && this.field !== 'text') this.finish('escape', e);
    });
    this.area.addEventListener('blur', () => this.close('blur'));
  }

  get activeId(): string | null {
    return this.item?.id ?? null;
  }

  get activeField(): EditField {
    return this.field;
  }

  open(item: EditTarget, field: EditField, value: string): void {
    this.item = item;
    this.field = field;
    this.closing = false;
    this.area.value = value;
    this.wrap.style.display = '';
    this.wrap.dataset.kind = field === 'text' ? item.kind : field;
    this.style();
    this.reposition();
    this.area.focus();
    this.area.setSelectionRange(value.length, value.length);
  }

  /** Объект поменялся (размер, шрифт) — подстроить поле. */
  update(item: BoxItem): void {
    if (this.item?.id !== item.id || this.field === 'label') return;
    this.item = item;
    this.style();
    this.reposition();
  }

  close(reason: CloseReason): void {
    if (!this.item || this.closing) return;
    this.closing = true;
    this.item = null;
    this.wrap.style.display = 'none';
    this.cb.onClose(reason);
  }

  /** Обернуть выделенный текст разметкой (или снять её, если она уже есть). */
  wrapSelection(mark: string): void {
    const a = this.area;
    const { selectionStart: s, selectionEnd: e, value } = a;
    const before = value.slice(0, s), sel = value.slice(s, e), after = value.slice(e);
    if (before.endsWith(mark) && after.startsWith(mark)) {
      a.value = before.slice(0, -mark.length) + sel + after.slice(mark.length);
      a.setSelectionRange(s - mark.length, e - mark.length);
    } else {
      a.value = before + mark + sel + mark + after;
      a.setSelectionRange(s + mark.length, e + mark.length);
    }
    this.autosize();
    this.cb.onInput(a.value);
  }

  private wrapKey(e: KeyboardEvent, mark: string): void {
    e.preventDefault();
    this.wrapSelection(mark);
  }

  destroy(): void {
    this.item = null;
    this.wrap.remove();
  }

  private finish(reason: CloseReason, e: KeyboardEvent): void {
    e.preventDefault();
    this.close(reason);
  }

  /** Поле следует за камерой. */
  reposition(): void {
    const item = this.item;
    if (!item) return;
    const zoom = this.view.cam.zoom;
    const p = this.view.worldToScreen(item.x, item.y);
    const s = this.wrap.style;
    if (this.field === 'title') {
      s.transform = `translate(${p.x}px, ${p.y - 24}px)`;
      s.width = `${Math.max(160, item.w * zoom)}px`;
      s.height = '22px';
      return;
    }
    s.transform = `translate(${p.x}px, ${p.y}px) scale(${zoom})`;
    s.width = `${item.w}px`;
    s.height = `${item.h}px`;
  }

  private style(): void {
    const item = this.item;
    if (!item) return;
    const a = this.area.style;
    if (this.field === 'title') {
      Object.assign(a, { fontSize: '13px', lineHeight: '20px', padding: '0 4px', textAlign: 'left', color: '#1f1f1f', fontWeight: '500' });
      this.wrap.style.alignItems = 'flex-start';
      return;
    }
    if (this.field === 'label') {
      Object.assign(a, { fontFamily: FONT, fontSize: '14px', lineHeight: '19px', padding: '3px 7px', textAlign: 'center', color: '#1f1f1f', fontWeight: '400' });
      this.wrap.style.alignItems = 'center';
      this.autosize();
      return;
    }
    const spec = labelSpec({ ...item, text: this.area.value || ' ' } as BoxItem);
    if (!spec) return;
    const size = fitFontSize(spec, item.w, item.h);
    Object.assign(a, {
      fontFamily: spec.fontFamily,
      fontSize: `${size}px`,
      lineHeight: `${lineHeightOf(size)}px`,
      padding: `${spec.pad}px`,
      textAlign: spec.align,
      fontWeight: spec.bold ? '700' : '400',
      fontStyle: spec.italic ? 'italic' : 'normal',
      color: `#${spec.color.toString(16).padStart(6, '0')}`,
    });
    this.wrap.style.alignItems = spec.vcenter ? 'center' : 'flex-start';
    this.autosize();
  }

  /** Высота поля по содержимому, чтобы вертикальное центрирование работало как у надписи. */
  private autosize(): void {
    const a = this.area;
    a.style.height = 'auto';
    a.style.height = `${a.scrollHeight}px`;
    if (this.item && this.field === 'text' && this.item.kind !== 'label') {
      const spec = labelSpec({ ...this.item, text: a.value || ' ' } as BoxItem);
      if (spec?.fit) {
        const size = fitFontSize(spec, this.item.w, this.item.h);
        a.style.fontSize = `${size}px`;
        a.style.lineHeight = `${lineHeightOf(size)}px`;
        a.style.height = 'auto';
        a.style.height = `${a.scrollHeight}px`;
      }
    }
  }
}
