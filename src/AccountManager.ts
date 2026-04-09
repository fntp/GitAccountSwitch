import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform } from './platform';

export interface Account {
  id: string;
  username: string;
  email: string;
  name: string;
  token: string;
  avatarUrl: string;
  active: boolean;
}

export interface AccountStore {
  github: Account[];
  gitee: Account[];
  gitlab: Account[];
}

// Simple uuid without dependency
function generateId(): string {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

const STORAGE_DIR = path.join(os.homedir(), '.git-account-switcher');
const STORAGE_FILE = path.join(STORAGE_DIR, 'accounts.json');

export class AccountManager {
  private static createEmptyStore(): AccountStore {
    return {
      github: [],
      gitee: [],
      gitlab: [],
    };
  }

  private static normalizeStore(raw: Partial<AccountStore> | undefined): AccountStore {
    const empty = this.createEmptyStore();
    return {
      github: Array.isArray(raw?.github) ? raw!.github : empty.github,
      gitee: Array.isArray(raw?.gitee) ? raw!.gitee : empty.gitee,
      gitlab: Array.isArray(raw?.gitlab) ? raw!.gitlab : empty.gitlab,
    };
  }

  static ensureDir(): void {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
  }

  static load(): AccountStore {
    this.ensureDir();
    if (!fs.existsSync(STORAGE_FILE)) {
      const empty = this.createEmptyStore();
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(empty, null, 2), 'utf-8');
      return empty;
    }
    try {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const store = this.normalizeStore(JSON.parse(raw) as Partial<AccountStore>);
      this.save(store);
      return store;
    } catch {
      return this.createEmptyStore();
    }
  }

  static save(store: AccountStore): void {
    this.ensureDir();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  }

  static addAccount(platform: Platform, account: Omit<Account, 'id' | 'active'>): Account {
    const store = this.load();
    const existing = store[platform].find(item => item.username.toLowerCase() === account.username.toLowerCase());
    if (existing) {
      const updated: Account = {
        ...existing,
        ...account,
      };
      store[platform] = store[platform].map(item => item.id === existing.id ? updated : item);
      this.save(store);
      return updated;
    }

    const newAccount: Account = {
      ...account,
      id: generateId(),
      active: store[platform].length === 0, // first account is active by default
    };
    store[platform].push(newAccount);
    this.save(store);
    return newAccount;
  }

  static setActive(platform: Platform, id: string): AccountStore {
    const store = this.load();
    store[platform] = store[platform].map(a => ({ ...a, active: a.id === id }));
    this.save(store);
    return store;
  }

  static deleteAccount(platform: Platform, id: string): AccountStore {
    const store = this.load();
    const wasActive = store[platform].find(a => a.id === id)?.active ?? false;
    store[platform] = store[platform].filter(a => a.id !== id);
    // If deleted account was active, make first one active
    if (wasActive && store[platform].length > 0) {
      store[platform][0].active = true;
    }
    this.save(store);
    return store;
  }

  static getStoragePath(): string {
    return STORAGE_FILE;
  }
}
