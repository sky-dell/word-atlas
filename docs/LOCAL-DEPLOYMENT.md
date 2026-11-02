# 本机部署与功能对齐

源码：`/data/word-atlas`，来源 `sky-dell/word-atlas`，基线 `99c0076`。

正式入口：https://43.133.166.184/#/atlas；账号入口：https://43.133.166.184/#/account。

独立服务：`word-atlas.service`，监听 `0.0.0.0:80` 和 HTTPS443，健康检查 `/health`。8888 已停止监听。HTTP80 保留游客学习与旧数据导出，账号API只在HTTPS启用。旧地址 `http://43.133.166.184/words/app.htm#/atlas` 及 `/words/` 下的相对资源继续兼容。原 AI-History-CSS 项目仍在8080，不受本次账号部署影响。开发/预览服务的5188配置不变。

## 维护命令

```bash
cd /data/word-atlas
npm ci
npm test
npm run check:atlas
TEST_URL=http://43.133.166.184 npm run test:e2e
systemctl status word-atlas
systemctl restart word-atlas
```

生产构建须在独立工作树完成，再发布已验证的dist并保留旧版于 `.local/releases/`；不要直接对正在服务的目录运行 `npm run build` 或旧 `npm run deploy`，后者会原地清空dist并更新8080静态镜像。8080镜像不提供账号功能，正式账号入口只能使用上述HTTPS地址。发布目录0755，服务专用word-atlas账号只读；仅保留绑定低端口能力。服务使用 `/opt/nodejs/node-v24.22.1-linux-x64/bin/node`，环境配置 `/etc/word-atlas/environment`，数据库 `/var/lib/word-atlas/accounts.sqlite`，证书 `/etc/word-atlas/tls`。数据库不得随程序发布覆盖。

已安装 `word-atlas-database-backup.timer` 和 `word-atlas-certificate-renew.timer`。管理员本机创建、账号数据生命周期、备份恢复与HTTP旧数据迁移详见 `ACCOUNTS-OPERATIONS.md`；本次检查和测试记录见 `ACCOUNTS-DATA-REVIEW.md`。

2026-10-28 完成主机更新与代码审计，报告和操作日志位于 `/data/host-audit-20261028/`。审计发现开发/预览私有素材访问控制与远端素材 ID 路径校验两项低风险缺陷，详见该目录报告链接；当前生产服务不运行 Vite，不存在私有 catalog/media-map 文件。不要将开发/预览服务作为公网生产入口；修复同步脚本前仅对可信来源手动同步。

## 功能范围

- 今日计划、FSRS 学习与复习、学习中断恢复、错词与连续学习统计。
- 7,298 词图鉴、等级/话题/状态筛选、中英搜索、网格/列表/WebGL 星图。
- 词卡英美发音、两条例句音频、例句查词、收藏、词族、分享卡、单词独立插画选择。
- 深浅/系统/星光/极光主题，三种英文字体，按等级/话题学习，重复朗读、主动回忆和考试计划。
- 打字、日常/雅思例句、听写、慢速、只听不看和查看答案；练习不修改 FSRS。
- 732 篇短文及理解题、3,185 道同义替换题（400 关）、226 组易混词。
- 《小王子》27 章、中英对照、逐段连续朗读、语言/速度/字号、词汇查阅和阅读位置。
- IndexedDB 进度、localStorage 迁移、标签页合并、写入失败重试、包含阅读与外观数据的备份。

## 与原站的边界

以 2026-10-28 可观察行为为参考，新增功能为可维护的独立实现，并非原站私有源码。保留上游署名及授权文件；在线新增内容的来源是对应公开 URL，并不据此扩大原授权范围。未来原站更新不会自动发布到本机。

考试计划按目标对应的 CEFR 范围及剩余天数估算每日词量；不声称与原站未公开的规划算法完全相同。书房采用普通阅读排版，没有复刻原站所有翻页/开场动画、待上线预告和 iOS 内测招募入口。

正式入口使用有效IP证书HTTPS，支持安全上下文；HTTP与HTTPS的浏览器存储独立，原HTTP用户先导出JSON再到HTTPS目标账号下导入。浏览器的自动播放策略仍可能要求先点击朗读。

## 内容同步

```bash
node scripts/sync-online.mjs
node scripts/sync-classic.mjs
node scripts/sync-extras.mjs
npm run check:atlas
npm test
# 在独立工作树构建、验证，再发布；不要原地清空生产dist。
```

原版图、缩略图、英美及日常音频来自仓库；词条索引/分块与第二条例句音频同步自线上。经典插画本地覆盖 7,297 词，未覆盖词回退到图鉴插画。书籍包含 1,478 段中英音频与 29 张图片。词库检查的 24 项词头未出现在例句的启发式警告已保留，不等同于确认内容错误。

浏览器截图与功能结果保存于 `docs/test-results/`，早期 failure 截图为调试历史，以最终 e2e.json 为准。
