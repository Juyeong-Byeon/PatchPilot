import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function readJsonArtifact<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJsonArtifact(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readTextArtifact(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function writeTextArtifact(filePath: string, value: string): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, value, "utf8");
}
