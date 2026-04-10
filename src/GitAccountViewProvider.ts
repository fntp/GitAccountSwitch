import * as vscode from 'vscode';
import { AccountManager, AccountStore } from './AccountManager';
import { GitManager } from './GitManager';
import { GitHubAuth } from './GitHubAuth';
import { GiteeAuth } from './GiteeAuth';
import { GitLabAuth } from './GitLabAuth';
import { PLATFORM_META, Platform } from './platform';

export class GitAccountViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitAccountSwitcher.view';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));

    // Re-push current account state whenever the panel becomes visible again.
    // Without this, after hiding/collapsing the sidebar the list shows stale
    // data because 'ready' is only sent once (on first webview creation) and
    // retainContextWhenHidden keeps the JS alive without re-firing it.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    });
  }

  refresh(): void {
    if (this._view) {
      const store = AccountManager.load();
      this._view.webview.postMessage({ command: 'updateAccounts', accounts: store });
    }
  }

  private async _handleMessage(message: any): Promise<void> {
    switch (message.command) {
      case 'ready':
      case 'refresh':
        this.refresh();
        break;

      case 'addAccount': {
        const platform = message.platform as Platform;
        this._sendLoading(true);
        try {
          const userInfo = await this._addAccountForPlatform(platform);
          if (userInfo) {
            const added = AccountManager.addAccount(platform, {
              username: userInfo.username,
              name: userInfo.name,
              email: userInfo.email,
              avatarUrl: userInfo.avatarUrl,
              token: userInfo.token,
            });
            // If this is the first account for the platform, AccountManager
            // automatically marks it active — but it never actually configures
            // git credentials. Do it now so the "active" badge reflects reality.
            if (added.active) {
              try {
                await GitManager.setGlobalUser(added.name || added.username, added.email);
                await GitManager.switchGlobalCredential(platform, added);
                const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
                for (const folder of workspaceFolders) {
                  await GitManager.cleanupLocalCredentialConfig(folder.uri.fsPath);
                }
              } catch {
                // Non-fatal: account is stored; user can switch manually.
              }
            }
            vscode.window.showInformationMessage(`✅ 已添加 ${PLATFORM_META[platform].label} 账户：${userInfo.username}`);
            this.refresh();
          }
        } finally {
          this._sendLoading(false);
        }
        break;
      }

      case 'switchAccount': {
        const { platform, id } = message as { platform: Platform; id: string };
        const store = AccountManager.load();
        const account = store[platform].find(a => a.id === id);
        if (account) {
          try {
            // 1. Update global git user identity (name + email)
            await GitManager.setGlobalUser(account.name || account.username, account.email);

            // 2. Switch the platform credential globally (host-wide, no per-path isolation).
            //    This replaces the stored token for github.com / gitee.com / gitlab.com so
            //    every repo on that host — initialized or not, open or not — will use the
            //    new account on the next push / pull / fetch.
            await GitManager.switchGlobalCredential(platform, account);

            // 3. Clean up any per-repo credential overrides left by previous versions of
            //    this extension (credential.useHttpPath=true / credential.username written
            //    as local git config). These would override the global credential we just set.
            const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
            for (const folder of workspaceFolders) {
              await GitManager.cleanupLocalCredentialConfig(folder.uri.fsPath);
            }

            // 4. Persist the active account selection and refresh UI only on success.
            AccountManager.setActive(platform, id);
            this.refresh();

            vscode.window.showInformationMessage(
              `✅ 已切换 ${PLATFORM_META[platform].label} 账户 → ${account.username}，所有仓库凭据已全局更新`
            );
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Git Account Switcher] Switch credential failed:', err);
            vscode.window.showErrorMessage(`切换失败: ${errorMsg}`, '查看日志').then(action => {
              if (action === '查看日志') {
                vscode.commands.executeCommand('workbench.action.toggleDevTools');
              }
            });
            // Refresh so UI stays in sync with stored state (active flag not updated).
            this.refresh();
          }
        } else {
          this.refresh();
        }
        break;
      }

      case 'deleteAccount': {
        const { platform, id } = message as { platform: Platform; id: string };
        const store = AccountManager.load();
        const account = store[platform].find(a => a.id === id);
        const confirm = await vscode.window.showWarningMessage(
          `确认删除账户 ${account?.username ?? id}？`,
          '删除',
          '取消'
        );
        if (confirm === '删除') {
          AccountManager.deleteAccount(platform, id);
          this.refresh();
        }
        break;
      }
    }
  }

  private _sendLoading(loading: boolean): void {
    this._view?.webview.postMessage({ command: 'setLoading', loading });
  }

  private async _addAccountForPlatform(platform: Platform): Promise<{
    username: string;
    name: string;
    email: string;
    avatarUrl: string;
    token: string;
  } | null> {
    switch (platform) {
      case 'github':
        return GitHubAuth.addAccount();
      case 'gitee':
        return GiteeAuth.addAccount();
      case 'gitlab':
        return GitLabAuth.addAccount();
      default:
        return null;
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const giteeLogo = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'gitee-logo.svg'));
    const gitlabLogo = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'gitlab-logo.svg'));

    return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: transparent;
    overflow-x: hidden;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background, #252526);
    z-index: 10;
  }
  .tabs {
    display: flex;
    min-width: 0;
    flex: 1;
  }
  .tab-btn {
    min-width: 0;
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 0;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    opacity: 0.6;
    border-bottom: 2px solid transparent;
    font-size: 13px;
    font-family: inherit;
    transition: opacity 0.15s, border-color 0.15s;
  }
  .tab-btn:hover { opacity: 0.9; background: var(--vscode-list-hoverBackground); }
  .tab-btn.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007fd4); }
  .tab-btn svg { flex-shrink: 0; }
  .platform-logo {
    width: 16px;
    height: 16px;
    display: block;
    object-fit: contain;
    flex-shrink: 0;
  }
  .refresh-btn {
    width: 28px;
    height: 28px;
    margin-right: 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--vscode-foreground);
    opacity: 0.72;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s ease, opacity 0.12s ease, transform 0.12s ease;
  }
  .refresh-btn:hover {
    opacity: 1;
    background: var(--vscode-list-hoverBackground);
  }
  .refresh-btn:active { transform: rotate(15deg); }

  .tab-content { display: none; padding: 8px 0; }
  .tab-content.visible { display: block; }
  .list-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 10px 8px;
  }
  .list-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.58;
  }
  .list-count {
    font-size: 11px;
    opacity: 0.48;
  }

  .account-list { display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }

  .account-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border-radius: 5px;
    cursor: pointer;
    position: relative;
    transition: background 0.1s;
  }
  .account-item:hover { background: var(--vscode-list-hoverBackground); }
  .account-item.is-active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

  .avatar {
    width: 34px; height: 34px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--vscode-panel-border);
  }
  .avatar-placeholder {
    width: 34px; height: 34px;
    border-radius: 50%;
    background: var(--vscode-button-background, #0e639c);
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 600; font-size: 15px;
    flex-shrink: 0;
  }

  .account-info { flex: 1; min-width: 0; }
  .account-username { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .account-email { font-size: 11px; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .active-badge {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4ec94e;
    flex-shrink: 0;
  }

  .delete-btn {
    display: none;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-errorForeground, #f48771);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
  }
  .account-item:hover .delete-btn { display: flex; align-items: center; }
  .delete-btn:hover { background: var(--vscode-inputValidation-errorBackground); }

  .add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: calc(100% - 12px);
    margin: 6px 6px 4px;
    padding: 8px;
    background: none;
    border: 1px dashed var(--vscode-panel-border, #555);
    color: var(--vscode-foreground);
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    opacity: 0.7;
    transition: opacity 0.1s, background 0.1s;
  }
  .add-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

  .empty-state {
    text-align: center;
    padding: 24px 16px 8px;
    opacity: 0.5;
    font-size: 12px;
    line-height: 1.6;
  }

  .loading-mask {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .loading-mask.visible { display: flex; }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: var(--vscode-focusBorder, #007fd4);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div class="topbar">
  <div class="tabs">
    <button class="tab-btn active" id="tab-github" onclick="switchTab('github')">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
               0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
               -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
               .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
               -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
               .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
               .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
               0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
    </svg>
    GitHub
    </button>
    <button class="tab-btn" id="tab-gitee" onclick="switchTab('gitee')">
      <img class="platform-logo" src="${giteeLogo}" alt="Gitee logo" />
    Gitee
    </button>
    <button class="tab-btn" id="tab-gitlab" onclick="switchTab('gitlab')">
      <img class="platform-logo" src="${gitlabLogo}" alt="GitLab logo" />
      GitLab
    </button>
  </div>
  <button class="refresh-btn" type="button" title="刷新账户列表" onclick="refreshAccounts()">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2a6 6 0 1 0 5.19 3H11.5a.75.75 0 0 1 0-1.5H15a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V6.31A7.5 7.5 0 1 1 8 .5a7.47 7.47 0 0 1 5.3 2.2.75.75 0 0 1-1.06 1.06A5.98 5.98 0 0 0 8 2Z"/>
    </svg>
  </button>
</div>

<div class="tab-content visible" id="content-github">
  <div class="list-toolbar">
    <div class="list-title">GitHub Accounts</div>
    <div class="list-count" id="count-github">0</div>
  </div>
  <div class="account-list" id="list-github"></div>
  <button class="add-btn" onclick="addAccount('github')">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5
               0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/>
    </svg>
    添加 GitHub 账户
  </button>
</div>

<div class="tab-content" id="content-gitee">
  <div class="list-toolbar">
    <div class="list-title">Gitee Accounts</div>
    <div class="list-count" id="count-gitee">0</div>
  </div>
  <div class="account-list" id="list-gitee"></div>
  <button class="add-btn" onclick="addAccount('gitee')">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5
               0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/>
    </svg>
    添加 Gitee 账户
  </button>
</div>

<div class="tab-content" id="content-gitlab">
  <div class="list-toolbar">
    <div class="list-title">GitLab Accounts</div>
    <div class="list-count" id="count-gitlab">0</div>
  </div>
  <div class="account-list" id="list-gitlab"></div>
  <button class="add-btn" onclick="addAccount('gitlab')">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5
               0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/>
    </svg>
    添加 GitLab 账户
  </button>
</div>

<div class="loading-mask" id="loadingMask">
  <div class="spinner"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let accounts = { github: [], gitee: [], gitlab: [] };
  let currentTab = 'github';

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('visible'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('content-' + tab).classList.add('visible');
  }

  function addAccount(platform) {
    vscode.postMessage({ command: 'addAccount', platform });
  }
  function refreshAccounts() {
    vscode.postMessage({ command: 'refresh' });
  }
  function switchAccount(platform, id) {
    vscode.postMessage({ command: 'switchAccount', platform, id });
  }
  function deleteAccount(platform, id, event) {
    event.stopPropagation();
    vscode.postMessage({ command: 'deleteAccount', platform, id });
  }

  function renderList(platform) {
    const list = document.getElementById('list-' + platform);
    const items = accounts[platform] || [];
    document.getElementById('count-' + platform).textContent = items.length + ' 个账号';

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无账户<br>点击下方按钮添加</div>';
      return;
    }

    list.innerHTML = items.map(acc => {
      const isActive = acc.active;
      const initial = (acc.username || '?')[0].toUpperCase();
      const avatarHtml = acc.avatarUrl
        ? '<img class="avatar" src="' + escHtml(acc.avatarUrl) + '" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\'"/>'
          + '<div class="avatar-placeholder" style="display:none">' + escHtml(initial) + '</div>'
        : '<div class="avatar-placeholder">' + escHtml(initial) + '</div>';

      return \`
        <div class="account-item \${isActive ? 'is-active' : ''}"
             onclick="switchAccount('\${platform}', '\${escHtml(acc.id)}')">
          \${avatarHtml}
          <div class="account-info">
            <div class="account-username">\${escHtml(acc.username)}</div>
            <div class="account-email">\${escHtml(acc.email || acc.name || '')}</div>
          </div>
          \${isActive ? '<div class="active-badge" title="当前激活"></div>' : ''}
          <button class="delete-btn" title="删除账户"
                  onclick="deleteAccount('\${platform}', '\${escHtml(acc.id)}', event)">×</button>
        </div>
      \`;
    }).join('');
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Message listener ──
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'updateAccounts') {
      accounts = msg.accounts;
      renderList('github');
      renderList('gitee');
      renderList('gitlab');
    } else if (msg.command === 'setLoading') {
      const mask = document.getElementById('loadingMask');
      mask.classList.toggle('visible', msg.loading);
    }
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
