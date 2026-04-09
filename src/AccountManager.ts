import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}

// Simple uuid without dependency
function generateId(): string {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

const STORAGE_DIR = path.join(os.homedir(), '.git-account-switcher');
const STORAGE_FILE = path.join(STORAGE_DIR, 'accounts.json');

export class AccountManager {

  static ensureDir(): void {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
  }

  static load(): AccountStore {
    this.ensureDir();
    if (!fs.existsSync(STORAGE_FILE)) {
      const empty: AccountStore = { github: [], gitee: [] };
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(empty, null, 2), 'utf-8');
      return empty;
    }
    try {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      return JSON.parse(raw) as AccountStore;
    } catch {
      const empty: AccountStore = { github: [], gitee: [] };
      return empty;
    }
  }

  static save(store: AccountStore): void {
    this.ensureDir();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  }

  static addAccount(platform: 'github' | 'gitee', account: Omit<Account, 'id' | 'active'>): Account {
    const store = this.load();
    const newAccount: Account = {
      ...account,
      id: generateId(),
      active: store[platform].length === 0, // first account is active by default
    };
    store[platform].push(newAccount);
    this.save(store);
    return newAccount;
  }

  static setActive(platform: 'github' | 'gitee', id: string): AccountStore {
    const store = this.load();
    store[platform] = store[platform].map(a => ({ ...a, active: a.id === id }));
    this.save(store);
    return store;
  }

  static deleteAccount(platform: 'github' | 'gitee', id: string): AccountStore {
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
