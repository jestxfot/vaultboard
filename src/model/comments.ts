// Статусы обсуждений и вид их булавок. Статус задаёт цвет и форму по умолчанию;
// у любого обсуждения их можно поменять — как своё поле объекта главнее стиля.
import type { CommentThread, PinShape } from './types.ts';

export interface StatusDef {
  id: string;
  name: string;
  color: string;
  shape: PinShape;
  /** Завершённые прячутся кнопкой «Скрыть завершённые». */
  done?: boolean;
}

export const STATUSES: StatusDef[] = [
  { id: 'open', name: 'Открыто', color: '#4262ff', shape: 'bubble' },
  { id: 'question', name: 'Вопрос', color: '#9b51e0', shape: 'diamond' },
  { id: 'idea', name: 'Идея', color: '#27ae60', shape: 'star' },
  { id: 'progress', name: 'В работе', color: '#f2994a', shape: 'circle' },
  { id: 'problem', name: 'Проблема', color: '#eb5757', shape: 'triangle' },
  { id: 'done', name: 'Завершено', color: '#8f8f8b', shape: 'square', done: true },
];

export const PIN_SHAPES: { shape: PinShape; name: string }[] = [
  { shape: 'bubble', name: 'Облачко' },
  { shape: 'circle', name: 'Круг' },
  { shape: 'square', name: 'Квадрат' },
  { shape: 'diamond', name: 'Ромб' },
  { shape: 'triangle', name: 'Треугольник' },
  { shape: 'star', name: 'Звезда' },
  { shape: 'flag', name: 'Флажок' },
  { shape: 'heart', name: 'Сердце' },
];

export const PIN_COLORS = ['#4262ff', '#2d9cdb', '#27ae60', '#9b51e0', '#f2994a', '#eb5757', '#e84393', '#f2c94c', '#1f1f1f', '#8f8f8b'];

export const REACTIONS = ['👍', '❤️', '😂', '🔥', '🤔', '👀', '✅', '❌'];

export function statusOf(t: CommentThread): StatusDef {
  return STATUSES.find((s) => s.id === (t.status ?? 'open')) ?? STATUSES[0];
}

export function pinColor(t: CommentThread): string {
  return t.color ?? statusOf(t).color;
}

export function pinShape(t: CommentThread): PinShape {
  return t.shape ?? statusOf(t).shape;
}

export function isDone(t: CommentThread): boolean {
  return !!statusOf(t).done;
}

/** SVG-контур булавки в квадрате 0…24. Острый угол «облачка» и «флажка» — точка крепления, внизу слева. */
export function pinPath(shape: PinShape): string {
  switch (shape) {
    case 'bubble': return 'M2 22V11a9 9 0 1 1 9 9H2Z';
    case 'circle': return 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20Z';
    case 'square': return 'M3 3h18v18H3Z';
    case 'diamond': return 'M12 1 23 12 12 23 1 12Z';
    case 'triangle': return 'M12 2 23 21H1Z';
    case 'star': return 'M12 1.5l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.6l-6.4 3.5L7 14l-5.3-5 7.2-.9Z';
    case 'flag': return 'M3 23V2h17l-4 5.5 4 5.5H5v10Z';
    case 'heart': return 'M12 21.5 3.2 12.7A5.3 5.3 0 0 1 12 5.3a5.3 5.3 0 0 1 8.8 7.4Z';
  }
}

/** Где у булавки точка крепления (доля её размера) — туда указывает «носик». Остальные формы крепятся центром. */
export function pinAnchor(shape: PinShape): { ax: number; ay: number } {
  if (shape === 'bubble' || shape === 'flag') return { ax: 0.1, ay: 0.95 };
  return { ax: 0.5, ay: 0.5 };
}

/** «5 мин назад», «вчера в 14:20», «3 сент.» — как в Miro. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'только что';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  const d = new Date(t);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (s < 86400 && new Date(now).getDate() === d.getDate()) return `сегодня в ${hm}`;
  if (s < 172800) return `вчера в ${hm}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: new Date(now).getFullYear() === d.getFullYear() ? undefined : 'numeric' });
}
