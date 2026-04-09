import * as vscode from 'vscode';
import * as https from 'https';

export interface GitHubUserInfo {
  username: string;
  name: string;
  email: string;
  avatarUrl: string;
  token: string;
}

function httpsGet(url: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'GitAccountSwitcher/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

export class GitHubAuth {

  /**
   * Full add-account flow:
   * 1. Open browser to GitHub PAT creation page (scopes pre-selected)
   * 2. Prompt user to paste the generated token
   * 3. Fetch user info from GitHub API
   */
  static async addAccount(): Promise<GitHubUserInfo | null> {
    // Step 1: Open browser to PAT creation page
    const tokenUrl = 'https://github.com/settings/tokens/new'
      + '?description=GitAccountSwitcher'
      + '&scopes=repo,user,read%3Aorg';

    const openResult = await vscode.window.showInformationMessage(
      '将在浏览器中打开 GitHub Token 创建页面。\n'
      + '请选择所需权限后点击"Generate token"，然后复制生成的 token。',
      '打开浏览器',
      '取消',
    );

    if (openResult !== '打开浏览器') { return null; }

    await vscode.env.openExternal(vscode.Uri.parse(tokenUrl));

    // Step 2: Ask user to paste token
    const token = await vscode.window.showInputBox({
      title: '粘贴 GitHub Personal Access Token',
      prompt: '请将刚才在浏览器中生成的 Token 粘贴到此处',
      password: true,
      ignoreFocusOut: true,
      validateInput: (val) => {
        if (!val || val.trim().length < 10) { return 'Token 不能为空'; }
        return null;
      },
    });

    if (!token) { return null; }

    // Step 3: Validate token and fetch user info
    try {
      const userInfo = await httpsGet('https://api.github.com/user', token.trim());

      if (userInfo.message) {
        vscode.window.showErrorMessage(`GitHub Token 验证失败: ${userInfo.message}`);
        return null;
      }

      let email = userInfo.email;

      // If email is private, fetch from emails API
      if (!email) {
        const emails: any[] = await httpsGet('https://api.github.com/user/emails', token.trim());
        const primary = emails.find((e: any) => e.primary);
        email = primary?.email ?? '';
      }

      return {
        username: userInfo.login,
        name: userInfo.name ?? userInfo.login,
        email: email ?? '',
        avatarUrl: userInfo.avatar_url ?? '',
        token: token.trim(),
      };
    } catch (err) {
      vscode.window.showErrorMessage(`无法连接 GitHub API，请检查网络或 Token: ${err}`);
      return null;
    }
  }
}
