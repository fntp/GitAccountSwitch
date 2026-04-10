import { exec } from 'child_process';
import { promisify } from 'util';
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
   * Switch Git credentials globally for the given platform account.
   *
   * Strategy:
   *  1. Unset global `credential.useHttpPath` — this key causes git to match
   *     credentials by repo path, so leaving it true means only the specific
   *     path we stored the credential for would match. We want host-wide matching.
   *  2. Clear any existing credential for the platform host.
   *  3. Store the new credential for the platform host WITHOUT a path, so it
   *     matches every repository on that host automatically.
   *
   * After this call, `git push / pull / fetch` for any repo on the platform
   * will use the new account's token without prompting.
   */
  static async switchGlobalCredential(platform: Platform, account: Account): Promise<void> {
    const host = PLATFORM_META[platform].host;

    // Step 1: Remove global useHttpPath so host-level matching works
    await this.unsetGlobalConfig('credential.useHttpPath');

    // Step 2: Clear existing credentials for this host (any username)
    await this.clearCredential(host);

    // Step 3: Store new credential (host-wide, no path)
    await this.storeCredential(host, account.username, account.token);
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
