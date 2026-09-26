// Markdown как в Obsidian: [[вики-ссылки]], ![[вставки]], ==выделение==, чекбоксы, перенос строки как <br>.
// Весь HTML из заметки проходит через белый список тегов и атрибутов: заметка может прийти из интернета,
// а обработчики вроде onerror выполнились бы внутри приложения.
import MarkdownIt from 'markdown-it';
import type { FileIndex } from '../io/files.ts';
import { vault } from '../io/vault.ts';

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export interface RenderOptions {
  /** Путь текущей заметки — от него ищутся одноимённые файлы по [[ссылкам]]. */
  from: string;
  /** Для карточки на доске: картинки не встраиваются (их там не загрузить), вместо них — подпись. */
  card?: boolean;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function createMarkdown(files: FileIndex) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true });

  // [[цель|подпись]] и ![[вставка]]
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    const embed = src.charCodeAt(pos) === 0x21;
    if (embed) pos++;
    if (!src.startsWith('[[', pos)) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('\n')) return false;
    if (!silent) {
      const token = state.push('wikilink', '', 0);
      token.meta = { inner, embed };
    }
    state.pos = end + 2;
    return true;
  });

  // ==выделение==
  md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (!src.startsWith('==', start)) return false;
    const end = src.indexOf('==', start + 2);
    if (end < 0 || end === start + 2) return false;
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      const t = state.push('text', '', 0);
      t.content = src.slice(start + 2, end);
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });

  let opts: RenderOptions = { from: '' };

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { inner, embed } = tokens[idx].meta as { inner: string; embed: boolean };
    const [target, alias] = inner.split('|');
    const path = files.resolve(target, opts.from);
    // У вставки картинки «|300» — это ширина, а не подпись.
    const sizeOnly = embed && !!alias && /^\d+(x\d+)?$/.test(alias.trim());
    const label = escape((sizeOnly || !alias ? target : alias).trim());
    if (embed && path && IMAGE.test(path)) {
      if (opts.card) return `<span class="embed">🖼 ${label}</span>`;
      const width = alias && /^\d+$/.test(alias.trim()) ? ` width="${alias.trim()}"` : '';
      return `<img src="${escape(vault.fileUrl(path))}" alt="${escape(target)}"${width}>`;
    }
    const cls = path ? 'wikilink' : 'wikilink unresolved';
    return `<a class="${cls}" data-target="${escape(target.trim())}" data-path="${escape(path ?? '')}">${label}</a>`;
  };

  // Чекбоксы задач: «- [ ] дело» и «- [x] сделано».
  md.core.ruler.after('inline', 'tasks', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children?.length) continue;
      const first = token.children[0];
      if (first.type !== 'text') continue;
      const m = /^\[([ xX])\]\s/.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = m[1] === ' ' ? '<span class="task">☐</span> ' : '<span class="task done">☑</span> ';
      token.children.unshift(box);
    }
  });

  return {
    render(text: string, options: RenderOptions): string {
      opts = options;
      // Свойства заметки (frontmatter) в тексте не показываем.
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      return sanitize(md.render(body));
    },
  };
}

export type Markdown = ReturnType<typeof createMarkdown>;

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'mark', 'code', 'pre', 'kbd', 'sub', 'sup', 'br', 'hr',
  'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'details', 'summary', 'font',
]);
const ALLOWED_ATTRS = new Set(['class', 'style', 'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'color', 'data-target', 'data-path', 'colspan', 'rowspan']);

/**
 * Очистка по белому списку. DOMParser строит «мёртвый» документ: скрипты и обработчики в нём не запускаются.
 * Картинки допускаются только из самой базы; внешние ссылки открываются в браузере, а не внутри приложения.
 */
export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
          child.remove();
        } else {
          // Сначала чистим содержимое, потом разворачиваем тег — иначе вложенное проскочило бы без проверки.
          walk(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        const unsafe =
          !ALLOWED_ATTRS.has(name) ||
          (name === 'style' && /url\s*\(|expression|@import/.test(value)) ||
          (name === 'href' && !/^(https?:|mailto:|#)/.test(value)) ||
          // Картинки — только файлы самой базы: у редактора с локального сервера, у сайта — опубликованные (f/…).
          (name === 'src' && !value.startsWith('/api/file?') && !/^f\/[0-9a-f]{20}\.[a-z0-9]{1,8}$/.test(value));
        if (unsafe) child.removeAttribute(attr.name);
      }
      if (tag === 'a' && child.getAttribute('href')) child.setAttribute('target', '_blank');
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
