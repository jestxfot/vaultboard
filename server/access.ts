// Приглашения и доступ гостей.
//
// Сервер vaultboard слушает только этот компьютер. Гости приходят к нему через туннель (Cloudflare): для сервера
// такой запрос тоже «с этого компьютера», поэтому гостя узнаём по заголовкам туннеля и чужому имени сайта в Host.
// Всё, что не с этого компьютера, — гость: он видит только доску из своего приглашения и её файлы.
//
// Приглашения лежат рядом с настройками компьютера (не в базе — чтобы ключи не уехали в git вместе с заметками).
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Role } from './live.ts';

export type GuestRole = Exclude<Role, 'owner'>;

export interface Invite {
  id: string;
  /** Секрет из ссылки. Кто знает его — тот и гость с этой ролью. */
  token: string;
  board: string;
  role: GuestRole;
  /** Для кого (подпись для автора: «Маша», «команда канала»). */
  label: string;
  created: string;
}

export const ROLE_NAMES: Record<GuestRole, string> = { view: 'смотрит', comment: 'комментирует', edit: 'правит' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostName(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0].toLowerCase();
}

/**
 * Запрос пришёл не с этого компьютера: через туннель (у Cloudflare есть заголовок cf-connecting-ip,
 * у прокси — x-forwarded-for) или по чужому имени сайта.
 */
export function isRemote(req: IncomingMessage): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return true;
  return !LOCAL_HOSTS.has(hostName(req.headers.host));
}

/**
 * Правку с этого компьютера может прислать и чужая страница в браузере (подделка запроса). Браузер всегда
 * подписывает такие запросы своим Origin — пропускаем только свой.
 */
export function foreignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET' || req.method === 'HEAD') return false;
  try {
    const o = new URL(origin);
    return !LOCAL_HOSTS.has(hostName(o.host)) || o.host !== req.headers.host;
  } catch {
    return true;
  }
}

export function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const INVITE_COOKIE = 'vb_invite';

export class InviteStore {
  private readonly file: string;
  private cache: Invite[] | null = null;

  constructor(settingsDir: string) {
    this.file = path.join(settingsDir, 'invites.json');
  }

  async list(): Promise<Invite[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.file, 'utf8')) as Invite[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async write(list: Invite[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(list, null, 1), 'utf8');
    await fs.rename(`${this.file}.tmp`, this.file);
    this.cache = list;
  }

  async byToken(token: string | null): Promise<Invite | null> {
    if (!token) return null;
    return (await this.list()).find((i) => i.token === token) ?? null;
  }

  /** Доски, у которых есть приглашения: их автор открывает вживую, через сервер. */
  async sharedBoards(): Promise<Set<string>> {
    return new Set((await this.list()).map((i) => i.board));
  }

  async create(board: string, role: GuestRole, label: string): Promise<Invite> {
    const invite: Invite = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(18).toString('base64url'),
      board,
      role,
      label: label.trim().slice(0, 60),
      created: new Date().toISOString(),
    };
    await this.write([...(await this.list()), invite]);
    return invite;
  }

  async update(id: string, change: Partial<Pick<Invite, 'role' | 'label'>>): Promise<Invite | null> {
    const list = await this.list();
    const cur = list.find((i) => i.id === id);
    if (!cur) return null;
    const next = { ...cur, ...change };
    await this.write(list.map((i) => (i.id === id ? next : i)));
    return next;
  }

  /** Отозвать: ссылка перестаёт работать сразу, гости с ней отключаются. */
  async remove(id: string): Promise<Invite | null> {
    const list = await this.list();
    const cur = list.find((i) => i.id === id) ?? null;
    if (cur) await this.write(list.filter((i) => i.id !== id));
    return cur;
  }
}
