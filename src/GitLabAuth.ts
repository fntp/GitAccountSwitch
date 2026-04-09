import * as https from 'https';
import * as vscode from 'vscode';

export interface GitLabUserInfo {
  username: string;
  name: string;
  email: string;
  avatarUrl: string;
  token: string;
}

function httpsGet(url: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'PRIVATE-TOKEN': token,
          'User-Agent': 'GitAccountSwitcher/1.0',
          'Accept': 'application/json',
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    ).on('error', reject);
  });
}

export class GitLabAuth {
  static async addAccount(): Promise<GitLabUserInfo | null> {
    const tokenUrl = 'https://gitlab.com/-/user_settings/personal_access_tokens';

    const openResult = await vscode.window.showInformationMessage(
      '将在浏览器中打开 GitLab Personal Access Token 页面。\n请至少勾选 read_user、read_repository 和 write_repository 权限后再创建令牌。',
      '打开浏览器',
      '取消',
    );

    if (openResult !== '打开浏览器') {
      return null;
    }

    await vscode.env.openExternal(vscode.Uri.parse(tokenUrl));

    const token = await vscode.window.showInputBox({
      title: '粘贴 GitLab Personal Access Token',
      prompt: '请将刚刚在浏览器中生成的 GitLab Token 粘贴到这里',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value || value.trim().length < 10) {
          return 'Token 不能为空';
        }
        return null;
      },
    });

    if (!token) {
      return null;
    }

    try {
      const normalizedToken = token.trim();
      const userInfo = await httpsGet('https://gitlab.com/api/v4/user', normalizedToken);

      if (userInfo.message || userInfo.error) {
        vscode.window.showErrorMessage(`GitLab Token 验证失败: ${userInfo.message || userInfo.error}`);
        return null;
      }

      let email = userInfo.public_email || userInfo.email || '';
      if (!email) {
        try {
          const emails = await httpsGet('https://gitlab.com/api/v4/user/emails', normalizedToken) as Array<{ email?: string }>;
          email = emails.find(item => item.email)?.email ?? '';
        } catch {
          // Some GitLab plans or tokens may not expose email APIs.
        }
      }

      if (!email) {
        email = await vscode.window.showInputBox({
          title: '补充 Git 提交邮箱',
          prompt: 'GitLab 没有返回邮箱，请手动填写这个账号用于 Git 提交的邮箱',
          ignoreFocusOut: true,
          validateInput: value => value.trim() ? null : '邮箱不能为空',
        }) ?? '';
      }

      if (!email) {
        return null;
      }

      return {
        username: userInfo.username,
        name: userInfo.name ?? userInfo.username,
        email,
        avatarUrl: userInfo.avatar_url ?? '',
        token: normalizedToken,
      };
    } catch (error) {
      vscode.window.showErrorMessage(`无法连接 GitLab API，请检查网络或 Token: ${error}`);
      return null;
    }
  }
}
