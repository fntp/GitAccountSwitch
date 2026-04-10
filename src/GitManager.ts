import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Account } from './AccountManager';
import { PLATFORM_META, Platform } from './platform';

const execAsync = promisify(exec);

export interface GitGlobalConfig {
  name: string;
  email: string;
}

export class GitManager {
  private static normalizeHost(host: string): string {
    return host.trim().toLowerCase().replace(/\.$/, '');
  }

  static async setGlobalUser(name: string, email: string): Promise<void> {
    await execAsync(`git config --global user.name "${name}"`);
    await execAsync(`git config --global user.email "${email}"`);
  }

  static async getGlobalUser(): Promise<GitGlobalConfig> {
    try {
      const { stdout: name } = await execAsync('git config --global user.name');
      const { stdout: email } = await execAsync('git config --global user.email');
      return {
        name: name.trim(),
        email: email.trim(),
      };
    } catch {
      return { name: '', email: '' };
    }
  }

  static async getConfig(key: string, cwd?: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git config --get ${key}`, { cwd });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * Unset a global git config key. Ignores errors (key may not exist).
   */
  static async unsetGlobalConfig(key: string): Promise<void> {
    try {
      await execAsync(`git config --global --unset ${key}`);
    } catch {
      // Ignore: config key may not be set
    }
  }

  /**
   * Unset a local git config key in the given repo. Ignores errors.
   */
  static async unsetLocalConfig(key: string, cwd: string): Promise<void> {
    try {
      await execAsync(`git config --local --unset ${key}`, { cwd });
    } catch {
      // Ignore: config key may not be set, or not a git repo
    }
  }

  static async setLocalConfig(key: string, value: string, cwd: string): Promise<void> {
    await execAsync(`git config --local ${key} "${value}"`, { cwd });
  }

  static async getRemoteUrl(cwd?: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd });
      const url = stdout.trim();
      return url ? url : null;
    } catch {
      try {
        const { stdout } = await execAsync('git remote -v', { cwd });
        const line = stdout.split('\n').find(item => item.includes('(fetch)'));
        if (!line) { return null; }
        const parts = line.trim().split(/\s+/);
        return parts[1] ?? null;
      } catch {
        return null;
      }
    }
  }

  static parseHostFromUrl(url: string): string | null {
    if (!url) { return null; }
    if (url.startsWith('git@')) {
      const afterAt = url.split('@')[1];
      return afterAt?.split(':')[0] ?? null;
    }
    try {
      const parsed = new URL(url);
      return parsed.hostname || null;
    } catch {
      return null;
    }
  }

  static isHttpRemoteUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  static isPlatformHost(platform: Platform, host: string): boolean {
    return this.normalizeHost(host) === this.normalizeHost(PLATFORM_META[platform].host);
  }

  private static buildCredentialInput(host: string, username?: string, password?: string): string {
    let input = `protocol=https\nhost=${host}\n`;
    if (username) {
      input += `username=${username}\n`;
    }
    if (password) {
      input += `password=${password}\n`;
    }
    return input;
  }

  /**
   * Store credential globally (no path) via `git credential approve`.
   * This makes the credential apply to ALL repos on the given host.
   */
  static async storeCredential(host: string, username: string, token: string): Promise<void> {
    const credInput = this.buildCredentialInput(host, username, token);
    await new Promise<void>((resolve, reject) => {
      const child = exec('git credential approve', (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
      child.stdin?.write(credInput);
      child.stdin?.end();
    });
  }

  /**
   * Clear stored credentials for a host via `git credential reject`.
   */
  static async clearCredential(host: string, username?: string): Promise<void> {
    const credInput = this.buildCredentialInput(host, username);
    await new Promise<void>((resolve, reject) => {
      const child = exec('git credential reject', (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
      child.stdin?.write(credInput);
      child.stdin?.end();
    });
  }

  /**
   * Write a credential entry to ~/.git-credentials (git-credential-store format).
   * Format: https://username:token@host
   *
   * This is the most reliable way to inject credentials because git reads this
   * file directly — VS Code's GitHub OAuth interceptor never gets a chance to
   * show a login popup.
   */
  static writeToCredentialStore(host: string, username: string, token: string): void {
    const credFile = path.join(os.homedir(), '.git-credentials');

    // Read existing file, strip any existing entry for this host
    let lines: string[] = [];
    if (fs.existsSync(credFile)) {
      lines = fs.readFileSync(credFile, 'utf-8')
        .split('\n')
        .filter(l => l.trim() && !l.includes(`@${host}`));
    }

    // Append new entry: encode special chars in username/token
    const u = encodeURIComponent(username);
    const p = encodeURIComponent(token);
    lines.push(`https://${u}:${p}@${host}`);

    fs.writeFileSync(credFile, lines.join('\n') + '\n', { mode: 0o600 });
  }

  /**
   * Remove all credential entries for the given host from ~/.git-credentials.
   */
  static removeFromCredentialStore(host: string): void {
    const credFile = path.join(os.homedir(), '.git-credentials');
    if (!fs.existsSync(credFile)) { return; }
    const lines = fs.readFileSync(credFile, 'utf-8')
      .split('\n')
      .filter(l => l.trim() && !l.includes(`@${host}`));
    fs.writeFileSync(credFile, lines.join('\n') + '\n', { mode: 0o600 });
  }

  /**
   * Ensure git's global credential.helper includes "store".
   *
   * If the helper is already "store" or contains "store", do nothing.
   * If it is set to something else (manager, osxkeychain, etc.), we prepend
   * "store" by adding a second helper entry — git tries helpers in order,
   * so "store" will satisfy the credential lookup before the other helper
   * even runs, which prevents VS Code's GitHub OAuth popup.
   * If no helper is set at all, we set it to "store".
   */
  static async ensureStoreHelperInChain(): Promise<void> {
    try {
      const { stdout } = await execAsync('git config --global --get-all credential.helper');
      const helpers = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
      if (helpers.some(h => h === 'store')) {
        return; // already present
      }
      // Prepend store so it runs first
      await execAsync('git config --global --add credential.helper store');
    } catch {
      // No helper configured yet → just set store
      try {
        await execAsync('git config --global credential.helper store');
      } catch { /* ignore */ }
    }
  }

  /**
   * Switch Git credentials globally for the given platform account.
   *
   * Why direct file approach instead of `git credential approve`:
   *   VS Code's built-in Git extension intercepts pushes and shows its own
   *   GitHub Sign-in dialog BEFORE the system credential helper is consulted.
   *   Writing directly to ~/.git-credentials bypasses that interceptor entirely
   *   because git resolves file-based credentials at the protocol level before
   *   VS Code authentication can fire.
   *
   * Steps:
   *  1. Ensure `credential.helper store` is in the global helper chain.
   *  2. Write the new token to ~/.git-credentials (replacing any old entry).
   *  3. Unset global credential.useHttpPath so the host-level entry matches
   *     every repo on that platform without path restrictions.
   */
  static async switchGlobalCredential(platform: Platform, account: Account): Promise<void> {
    const host = PLATFORM_META[platform].host;

    // 1. Make sure git will use the file-based credential store
    await this.ensureStoreHelperInChain();

    // 2. Write/replace the credential entry directly
    this.writeToCredentialStore(host, account.username, account.token);

    // 3. Remove path-based matching so the host entry matches all repos
    await this.unsetGlobalConfig('credential.useHttpPath');
  }

  /**
   * Remove per-repo credential overrides that may have been written by
   * a previous version of this extension. Call this for every open workspace
   * folder after switching accounts.
   */
  static async cleanupLocalCredentialConfig(cwd: string): Promise<void> {
    // These local overrides interfere with host-wide credential matching
    await this.unsetLocalConfig('credential.useHttpPath', cwd);
    await this.unsetLocalConfig('credential.username', cwd);
  }
}
