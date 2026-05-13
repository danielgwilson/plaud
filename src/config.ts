import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PlaudConfig = {
  authToken?: string;
  region?: "us" | "eu";
};

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "plaud", "config.json");
}

export async function readConfig(): Promise<PlaudConfig> {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as PlaudConfig) : {};
  } catch {
    return {};
  }
}

export async function writeConfig(config: PlaudConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const json = JSON.stringify(config, null, 2);
  await fs.writeFile(configPath, json, { mode: 0o600 });
  // Ensure correct perms even if the file already existed with looser permissions.
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // ignore
  }
}

export async function clearConfig(): Promise<void> {
  const configPath = getConfigPath();
  try {
    await fs.unlink(configPath);
  } catch {
    // ignore
  }
}

export function redactToken(token: string): string {
  if (!token) return "";
  const clean = String(token).trim().replace(/^bearer\s+/i, "");
  if (clean.length <= 12) return `${clean.slice(0, 4)}…`;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

