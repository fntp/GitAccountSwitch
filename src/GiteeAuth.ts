import * as vscode from 'vscode';
import * as https from 'https';

export interface GiteeUserInfo {
  username: string;
  name: string;
  email: string;
  avatarUrl: string;
  token: string;
}

function httpsGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'GitAccountSwitcher/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

export class GiteeAuth {

  /**
   * Full add-account flow:
   * 1. Open browser to Gitee PAT creation page
   * 2. Prompt user to paste token
   * 3. Fetch user info from Gitee API
   */
  static async addAccount(): Promise<GiteeUserInfo | null> {
    const tokenUrl = 'https://gitee.com/profile/personal_access_tokens/new';

    const openResult = await vscode.window.showInformationMessage(
      '将在浏览器中打开 Gitee Token 创建页面。\n'
      + '请勾选 user_info 和 projects 权限后点击"提交"，然后复制生成的 token。',
      '打开浏览器',
      '取消',
    );

    if (openResult !== '打开浏览器') { return null; }

    await vscode.env.openExternal(vscode.Uri.parse(tokenUrl));

    const token = await vscode.window.showInputBox({
      title: '粘贴 Gitee 私人令牌（Personal Access Token）',
      prompt: '请将刚才在浏览器中生成的令牌粘贴到此处',
      password: true,
      ignoreFocusOut: true,
      validateInput: (val) => {
        if (!val || val.trim().length < 10) { return 'Token 不能为空'; }
        return null;
      },
    });

    if (!token) { return null; }

    try {
      const apiUrl = `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token.trim())}`;
      const userInfo = await httpsGet(apiUrl);

      if (userInfo.message || userInfo.error) {
        vscode.window.showErrorMessage(`Gitee Token 验证失败: ${userInfo.message || userInfo.error}`);
        return null;
      }

      return {
        username: userInfo.login,
        name: userInfo.name ?? userInfo.login,
        email: userInfo.email ?? '',
        avatarUrl: userInfo.avatar_url ?? '',
        token: token.trim(),
      };
    } catch (err) {
      vscode.window.showErrorMessage(`无法连接 Gitee API，请检查网络或 Token: ${err}`);
      return null;
    }
  }
}
