// Туннель Cloudflare: делает сервер vaultboard доступным гостям из интернета по адресу вида
// https://слова-через-дефис.trycloudflare.com — без аккаунта, без белого адреса и настройки роутера.
// Сам сервер по-прежнему слушает только этот компьютер; туннель — отдельная программа cloudflared,
// которая держит исходящее соединение с Cloudflare. Адрес новый при каждом запуске туннеля.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

export type TunnelState =
  | { kind: 'off' }
  | { kind: 'missing' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'starting' }
  | { kind: 'on'; url: string; since: string }
  | { kind: 'error'; message: string };

const DOWNLOAD: Partial<Record<string, string>> = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-amd64.exe',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
};

export class Tunnel {
  state: TunnelState = { kind: 'off' };
  private proc: ChildProcess | null = null;
  private readonly binDir: string;
  private readonly onChange: (s: TunnelState) => void;

  constructor(binDir: string, onChange: (s: TunnelState) => void) {
    this.binDir = binDir;
    this.onChange = onChange;
  }

  private set(s: TunnelState): void {
    this.state = s;
    this.onChange(s);
  }

  private get ownBinary(): string {
    return path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  /** Где cloudflared: своя копия vaultboard, установленная (winget, brew, пакет) или нигде. */
  async find(): Promise<string | null> {
    if (await fs.stat(this.ownBinary).catch(() => null)) return this.ownBinary;
    const candidates = process.platform === 'win32'
      ? [path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe')]
      : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
    for (const c of candidates) if (await fs.stat(c).catch(() => null)) return c;
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
    const found = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : '';
    return found || null;
  }

  /** Можно ли скачать cloudflared самим (для этой системы есть готовый файл). */
  get canDownload(): boolean {
    return !!DOWNLOAD[`${process.platform}-${os.arch()}`];
  }

  /** Скачать cloudflared с официальной страницы релизов Cloudflare на GitHub в папку vaultboard. */
  async download(): Promise<void> {
    const name = DOWNLOAD[`${process.platform}-${os.arch()}`];
    if (!name) throw new Error('Для этой системы поставь cloudflared сам (macOS: brew install cloudflared)');
    this.set({ kind: 'downloading', percent: 0 });
    await fs.mkdir(this.binDir, { recursive: true });
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`GitHub ответил ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let got = 0;
    let shown = -1;
    const tmp = `${this.ownBinary}.download`;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      got += chunk.length;
      const percent = total ? Math.floor((got / total) * 100) : 0;
      if (percent !== shown) {
        shown = percent;
        this.set({ kind: 'downloading', percent });
      }
    });
    await pipeline(body, createWriteStream(tmp));
    if (process.platform !== 'win32') await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, this.ownBinary);
    this.set({ kind: 'off' });
  }

  /** Поднять туннель к серверу на этом порту. Готово, когда Cloudflare выдал адрес. */
  async start(port: number): Promise<void> {
    if (this.proc) return;
    const bin = await this.find();
    if (!bin) {
      this.set({ kind: 'missing' });
      return;
    }
    this.set({ kind: 'starting' });
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let buffer = '';
    const onText = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString('utf8')).slice(-8000);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buffer);
      if (m && this.state.kind !== 'on') this.set({ kind: 'on', url: m[0], since: new Date().toISOString() });
    };
    proc.stdout?.on('data', onText);
    proc.stderr?.on('data', onText);
    proc.on('error', (err) => {
      this.proc = null;
      this.set({ kind: 'error', message: err.message });
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.set(code === 0 || this.state.kind === 'off' ? { kind: 'off' } : { kind: 'error', message: `cloudflared завершился (код ${code})` });
    });
    // Адреса нет за 40 с — что-то не так (нет интернета, блокирует антивирус).
    setTimeout(() => {
      if (this.proc === proc && this.state.kind === 'starting') {
        this.stop();
        this.set({ kind: 'error', message: 'Cloudflare не выдал адрес за 40 секунд — проверь интернет' });
      }
    }, 40_000).unref();
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.set({ kind: 'off' });
    p?.kill();
  }
}
