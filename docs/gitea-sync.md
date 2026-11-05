# 手动同步 Gitea 提交统计

在能访问内网 Gitea 的电脑上执行。当前终端需要设置环境变量 `gitea`，GitHub CLI（`gh`）需要已登录。
Worker 密钥由脚本读取本机的 `~/.config/personal-coding-stats/ingest-key`，不要把密钥写进文档。

```sh
cd /Users/chris/Documents/waka-readme-stats

.venv/bin/python scripts/sync-gitea.py \
  --gitea-url https://code.qianshi.cn \
  --worker-api https://personal-coding-stats.personal-coding-stats.workers.dev/api/v1/ &&
gh workflow run main.yml --repo chriscco/chriscco
```

第一步扫描提交历史并更新 D1 中的私有快照，可能需要几分钟。成功后才会触发 GitHub 工作流更新 README。

只补充 commit 时段和星期统计，不把 Gitea 数据加入编码时长、热力图或仓库语言统计。
没有配置自动采集 Gitea；每日 README 更新会复用上次手动同步的快照。

查看最近一次 README 更新的状态：

```sh
gh run list --repo chriscco/chriscco --workflow main.yml --limit 1
```
