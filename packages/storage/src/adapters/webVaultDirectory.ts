import type { Ciphertext, EpochMs, VaultId } from '@ankylock/core';
import { isString, isVaultEntry, shape } from '../guards.js';
import { StorageError, type IStorageEngine, type IVaultDirectory, type VaultEntry } from '../interfaces/IStorageEngine.js';
import { LEGACY_DB_NAME, WebIndexedDbAdapter } from './webIndexedDbAdapter.js';

const REGISTRY_DB = 'ankylock-vaults';
const REGISTRY_STORE = 'vaults';

/** A registry row: the public entry plus the IndexedDB database holding the vault. */
interface VaultRecord extends VaultEntry {
  readonly database: string;
}

const isVaultRecord = (value: unknown): value is VaultRecord =>
  isVaultEntry(value) && shape<{ database: string }>({ database: isString })(value);

function promised<T>(req: IDBRequest, guard: (value: unknown) => value is T): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result: unknown = req.result;
      if (guard(result)) resolve(result);
      else reject(new StorageError('ERR_STORAGE', 'Unexpected record shape in the vault registry.'));
    };
    req.onerror = () => reject(new StorageError('ERR_STORAGE', req.error?.message ?? 'Vault registry request failed.'));
  });
}

function openRegistry(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(REGISTRY_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(REGISTRY_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('ERR_STORAGE', req.error?.message ?? 'Cannot open the vault registry.'));
  });
}

const toEntry = ({ id, createdAt, lastOpenedAt }: VaultRecord): VaultEntry => ({ id, createdAt, lastOpenedAt });

/**
 * Browser vaults: a small registry database lists the vaults (ids and timestamps only), and each
 * vault lives in its own IndexedDB database, `ankylock-<vaultId>`.
 */
export class WebVaultDirectory implements IVaultDirectory {
  readonly #factory: IDBFactory;
  readonly #now: () => EpochMs;
  readonly #registry: Promise<IDBDatabase>;
  #adopted: Promise<void> | null = null;
  #current: WebIndexedDbAdapter | null = null;

  constructor(factory: IDBFactory = indexedDB, now: () => EpochMs = () => Date.now() as EpochMs) {
    this.#factory = factory;
    this.#now = now;
    this.#registry = openRegistry(factory);
  }

  async #records(): Promise<VaultRecord[]> {
    const store = (await this.#registry).transaction(REGISTRY_STORE, 'readonly').objectStore(REGISTRY_STORE);
    return promised(store.getAll(), (v): v is VaultRecord[] => Array.isArray(v) && v.every(isVaultRecord));
  }

  async #put(record: VaultRecord): Promise<void> {
    const store = (await this.#registry).transaction(REGISTRY_STORE, 'readwrite').objectStore(REGISTRY_STORE);
    await promised(store.put(record), (_v): _v is unknown => true);
  }

  /** Registers the pre-vault-id database as the first vault if it holds an initialized vault. */
  #adoptLegacy(): Promise<void> {
    this.#adopted ??= (async () => {
      if ((await this.#records()).length > 0) return;
      const existing = await this.#factory.databases();
      if (!existing.some((db) => db.name === LEGACY_DB_NAME)) return;
      const legacy = new WebIndexedDbAdapter(this.#factory, this.#now, LEGACY_DB_NAME);
      const header = await legacy.getVaultHeader();
      await legacy.close();
      if (header === null) return;
      const now = this.#now();
      await this.#put({ id: crypto.randomUUID() as VaultId, createdAt: now, lastOpenedAt: now, database: LEGACY_DB_NAME });
    })();
    return this.#adopted;
  }

  #switchTo(storage: WebIndexedDbAdapter): WebIndexedDbAdapter {
    const previous = this.#current;
    this.#current = storage;
    void previous?.close();
    return storage;
  }

  async list(): Promise<VaultEntry[]> {
    await this.#adoptLegacy();
    return (await this.#records()).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).map(toEntry);
  }

  async create(id: VaultId, header: string, nameCiphertext: Ciphertext): Promise<IStorageEngine> {
    await this.#adoptLegacy();
    if ((await this.#records()).some((r) => r.id === id)) {
      throw new StorageError('ERR_INVALID_SETTING', 'A vault with this id already exists.');
    }
    const database = `ankylock-${id}`;
    const storage = new WebIndexedDbAdapter(this.#factory, this.#now, database);
    // The header is written before the vault is registered, so the list never shows a vault
    // that cannot be unlocked.
    await storage.initializeVault(header, nameCiphertext);
    const now = this.#now();
    await this.#put({ id, createdAt: now, lastOpenedAt: now, database });
    return this.#switchTo(storage);
  }

  async open(id: VaultId): Promise<IStorageEngine> {
    await this.#adoptLegacy();
    const record = (await this.#records()).find((r) => r.id === id);
    if (!record) throw new StorageError('ERR_NOT_FOUND', 'Vault not found.');
    await this.#put({ ...record, lastOpenedAt: this.#now() });
    return this.#switchTo(new WebIndexedDbAdapter(this.#factory, this.#now, record.database));
  }
}
