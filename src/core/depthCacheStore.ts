import type { DepthFrame } from "./types";

// Хранилище запечённого кеша глубины в IndexedDB (кеш большой — localStorage не подходит).
// Один кеш = { fps, frames: DepthFrame[] }. IndexedDB сохраняет Uint8Array через structured clone.

export interface DepthCache {
  fps: number;
  frames: DepthFrame[];
}

const DB = "videofx";
const STORE = "depthCaches";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function saveCache(name: string, cache: DepthCache): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ fps: cache.fps, frames: cache.frames, count: cache.frames.length }, name);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function loadCache(name: string): Promise<DepthCache | null> {
  const db = await open();
  const out = await new Promise<DepthCache | null>((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => res(req.result ? { fps: req.result.fps, frames: req.result.frames } : null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return out;
}

export async function listCaches(): Promise<string[]> {
  try {
    const db = await open();
    const names = await new Promise<string[]>((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => res((req.result as string[]) ?? []);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return names.sort();
  } catch {
    return [];
  }
}

export async function deleteCache(name: string): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}
