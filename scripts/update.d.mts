// Типы для scripts/update.mjs — его подключает сервер (проверка «вышел ли новый релиз»).
export interface Release {
  tag: string;
  name: string;
  notes: string;
  url: string;
  zip: string;
}
export const REPO: string;
export const STATE_FILE: string;
export function settingsFile(): string;
export function installedState(projectDir: string): { tag: string; date: string; files: string[] } | null;
export function isGitCheckout(projectDir: string): boolean;
export function parseVersion(v: unknown): [number, number, number] | null;
export function isNewer(a: string, b: string): boolean;
export function currentVersion(projectDir: string): string;
export function latestRelease(timeoutMs?: number): Promise<Release | null>;
export function readZip(buf: Buffer): { name: string; data: Buffer }[];
export function applyUpdate(projectDir: string, release: Release, log?: (s: string) => void): Promise<boolean>;
export function installDeps(projectDir: string, log?: (s: string) => void): void;
