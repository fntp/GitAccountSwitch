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

  static async isCredentialUseHttpPath(cwd?: string): Promise<boolean> {
    return (await this.getConfig('credential.useHttpPath', cwd)).toLowerCase() === 'true';
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

  static parsePathFromUrl(url: string): string | undefined {
    if (!url) { return undefined; }
    if (url.startsWith('git@')) {
      const parts = url.split(':');
      if (parts.length < 2) { return undefined; }
      const path = parts.slice(1).join(':');
      return path.startsWith('/') ? path : `/${path}`;
    }
    try {
      const parsed = new URL(url);
      return parsed.pathname || undefined;
    } catch {
      return undefined;
    }
  }

  static isHttpRemoteUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  static isPlatformHost(platform: Platform, host: string): boolean {
    return this.normalizeHost(host) === this.normalizeHost(PLATFORM_META[platform].host);
  }

  private static buildCredentialInput(host: string, username?: string, password?: string, path?: string): string {
    let input = `protocol=https\nhost=${host}\n`;
    if (path) {
      input += `path=${path}\n`;
    }
    if (username) {
      input += `username=${username}\n`;
    }
    if (password) {
      input += `password=${password}\n`;
    }
    return input;
  }

  /**
   * Store credential in git credential store
   * Uses git credential approve to store token as password for the host
   */
  static async storeCredential(host: string, username: string, token: string, path?: string): Promise<void> {
    const credInput = this.buildCredentialInput(host, username, token, path);
    await new Promise<void>((resolve, reject) => {
      const child = exec('git credential approve', (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
      child.stdin?.write(credInput);
      child.stdin?.end();
    });
  }

  /**
   * Clear stored credentials for a host
   */
  static async clearCredential(host: string, path?: string, username?: string): Promise<void> {
    const credInput = this.buildCredentialInput(host, username, undefined, path);
    await new Promise<void>((resolve, reject) => {
      const child = exec('git credential reject', (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
      child.stdin?.write(credInput);
      child.stdin?.end();
    });
  }

  static async configureWorkspaceCredential(cwd: string, platform: Platform, account: Account): Promise<{
    configured: boolean;
    message: string;
    host?: string;
  }> {
    const remoteUrl = await this.getRemoteUrl(cwd);
    if (!remoteUrl) {
      return {
        configured: false,
        message: '当前仓库未找到远程地址，已仅切换全局 Git 身份。',
      };
    }

    const host = this.parseHostFromUrl(remoteUrl);
    if (!host) {
      return {
        configured: false,
        message: '当前仓库远程地址无法解析 host，已仅切换全局 Git 身份。',
      };
    }

    if (!this.isHttpRemoteUrl(remoteUrl)) {
      return {
        configured: false,
        message: '当前仓库远程地址不是 HTTP/HTTPS，无法自动改写 PAT 凭据。',
      };
    }

    if (!this.isPlatformHost(platform, host)) {
      return {
        configured: false,
        message: `当前仓库远程 host 是 ${host}，与所选 ${PLATFORM_META[platform].label} 账号不匹配，已仅切换全局 Git 身份。`,
      };
    }

    const credentialPath = this.parsePathFromUrl(remoteUrl);
    if (!credentialPath) {
      return {
        configured: false,
        message: '当前仓库远程地址无法解析仓库路径，已仅切换全局 Git 身份。',
      };
    }

    await this.setLocalConfig('credential.useHttpPath', 'true', cwd);
    await this.setLocalConfig('credential.username', account.username, cwd);

    await this.clearCredential(host);
    await this.clearCredential(host, credentialPath);
    await this.storeCredential(host, account.username, account.token, credentialPath);

    return {
      configured: true,
      message: `已为 ${host}${credentialPath} 切换凭据，并启用按仓库路径隔离。`,
      host,
    };
  }
}
