# 卡罗琳特辑（Karoline）

当前交付：书房第三分类、21 个去重后的本地视频、按序封面卡片及视频播放页。此前听力设计中的问答拆段、转录翻译、听写和学习进度不是此轮交付内容。

## 文件与编号

- 用户确认素材允许在项目使用。有效原始文件保留在 `/data/word-atlas/karolin_video`。2026-11-02 按用户要求去掉重复第 16 课的 360p 版本，保留 480p，低清原件与网页派生文件移入 `/data/host-audit-20261101/karoline-dedup-vCqhvO`，可回滚，不对外提供。
- 网页版本在 `public/atlas/extras/karoline/`，有效 ID 为 01–15、17–22，共 21 个 MP4 与 21 张同名 JPG；索引为 `index.json`。显示序号仍连续为 01–21，不要由显示序号推导文件路径。
- 未带课号的 `32725731177-1-192.mp4` 为 01「开篇 · 跟读练习」，原第 2–15 课使用 ID 02–15。
- 第 16 课只保留 ID 17（480p），原第 17–21 课沿用 ID 18–22，避免已有链接指向别的课程。旧页面链接 `id=karoline-16` 会显示保留的第 16 课；低清 MP4 文件已撤下。
- 原始文件名、SHA-256 和网页版本对应关系记录在 `.local/karoline/source-mapping.json`。逐文件来源及派生视频/封面指纹为 `.local/karoline/karoline-NN.source.json`，不公开暴露服务器原始路径。
- 04、07、11、20（原课号 4、7、11、19）没有音轨，卡片与播放页均提示。不插入伪造音轨，不宣称可用于听力。

## 生成与复核

需要带 libx264 的 FFmpeg 和 ffprobe。执行：

```sh
FFMPEG_BIN=/absolute/path/to/ffmpeg /usr/local/bin/node scripts/prepare-karoline.mjs /data/word-atlas/karolin_video
```

源文件先做 SHA-256，H.264 视频复制视频流，其余生成 H.264/yuv420p，保留现有 AAC 音轨，MP4 添加 fast-start。每个封面由对应网页视频约第 12 秒提取，短视频取四分之一处。生成前检查编码器；单线程、低优先级运行可以减少对线上应用的影响。

只有来源和视频/封面指纹全部一致才复用产物。中断/过时的网页派生文件移入 `.local/karoline/work-*`，与原始输入无关；每次使用独立临时目录，核验后发布最终文件。该目录可能保留失败或旧版本的派生文件，管理员确认后可单独清理，不能清理原视频目录。

## 页面与播放

- 列表：`#/read?tab=karoline`。
- 详情示例：`#/read?tab=karoline&id=karoline-01`。
- 播放页支持原生控件、拖动定位、倍速、单集循环、上一集/下一集、返回列表。不自动播放；离开页面释放播放器。
- 全部视频与封面同源提供，不依赖 YouTube、外部 iframe 或第三方字体服务。
- 静态服务使用 `video/mp4`，保留 Range/HEAD 支持；服务工作线程不把完整 MP4 放入应用离线缓存。浏览器自己的正常媒体缓存不属于用户学习记录。
- 视频库本身是公共静态内容，不修改账户/游客数据库、TTL、SMTP 或用户学习资料。

## 验证

```sh
PATH=/opt/nodejs/node-v24.22.1-linux-x64/bin:$PATH npm run build
/usr/local/bin/node --test server/*.test.mjs scripts/*.test.mjs
/usr/local/bin/node scripts/run-browser-checks.mjs unit
```

`src/pages/karoline.browser.test.ts` 使用隔离的本地账户/游客测试服务，检查全部 21 张封面、顺序、全部 21 个实际视频解码与拖动、480p 第 16 课唯一性、旧链接兼容、倍速、上一/下一集路由、刷新、缺音提示、非法 ID、手机/平板/桌面宽度及原版书/短文回归。测试结果与截图保存在 `.local/karoline`。

服务器本地真实播放验证不等于大陆各地网络性能验证；上线后仍需用户侧检查首帧等待和播放流畅度。
