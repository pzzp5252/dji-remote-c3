# 手机双机录像工具：最新版 UI/UX 评审入口

> 请使用 **`review/uiux-current-20261113` 分支**，不要把默认 `main` 的旧版本当成本次实现。
> 本分支发布当前本地源码（包括此前尚未提交的 UI 修改）以及独立图文说明；不代表已完成 iPhone/Bluefy 或真实双机验收。

## 建议阅读顺序

1. [独立图文 PDF](docs/ui/phone-uiux-current-20261112/UIUX-STANDALONE.pdf)：26 页，内嵌 21 张截图、交互说明、证据边界和评审任务。可以下载后作为网页 AI 唯一附件。
2. [图文 Markdown](docs/ui/phone-uiux-current-20261112/README.md)：便于浏览器 AI 直接读取，含原始截图相对链接。
3. 当前源码：[页面与交互](phone/app.mjs)、[样式与布局](phone/styles.css)、[BLE 客户端](phone/ble-client.mjs)、[离线缓存](phone/sw.js)、[HTML 入口](phone/index.html)。
4. 契约与回归：[BLE 契约](schema/phone-ble.md)、[事件契约](schema/events.md)、[手机 UI 行为测试](tests/test_phone_ui.mjs)、[BLE 客户端测试](tests/test_phone_client.mjs)。
5. [可直接复制的完整评审提示](docs/ui/phone-uiux-current-20261112/AI-REVIEW-PROMPT.md)。

GitHub 页面不便读取时，使用下面的纯文本入口（分支已在 URL 中明确指定）：

- [本入口纯文本](https://raw.githubusercontent.com/pzzp5252/dji-remote-c3/refs/heads/review/uiux-current-20261113/AI-REVIEW.md)
- [图文说明纯文本](https://raw.githubusercontent.com/pzzp5252/dji-remote-c3/refs/heads/review/uiux-current-20261113/docs/ui/phone-uiux-current-20261112/README.md)
- [app.mjs 纯文本](https://raw.githubusercontent.com/pzzp5252/dji-remote-c3/refs/heads/review/uiux-current-20261113/phone/app.mjs)
- [styles.css 纯文本](https://raw.githubusercontent.com/pzzp5252/dji-remote-c3/refs/heads/review/uiux-current-20261113/phone/styles.css)

## 产品、现状与边界

这是个人或小范围使用的手机双机录像遥控与拍摄记录工具。操作者选择项目清单中的动作/点位，经 ESP32-C3 控制两台相机录停，再检查、更正、导出记录。用户对当前 UI 和真机体验不满意，希望另一个 AI 独立给出有证据的改进方向，不是替现有设计背书。

截图对应 2026-11-12 的实现，来自独立 mock BLE client 与内存 storage，是当前代码的真实浏览器渲染，不是用户 iPhone 截屏或真机证据。模拟数据与截图元数据在 [fixture](docs/ui/phone-uiux-current-20261112/capture-fixture.json) 和 [manifest](docs/ui/phone-uiux-current-20261112/capture-manifest.json)。源码中的 v8 修正了“清单不匹配、START 禁用却仍提示可以开录”的矛盾；这不表示用户其他未定位问题已解决。

可以重新评估信息架构、分组、密度、留白、导航、抽屉与操作路径，不要求维护现有扁平或卡片风格。必须保留安全 STOP、真实相机状态确认、项目/模板隔离、设备主记录与手机副本区分、持久化失败披露和数据不丢失；不要用清空项目、绕过门禁或自动重试录停来美化体验。

## 给网页 AI 的简短任务

请阅读这个评审分支的图文说明与 `phone/` 源码，自主评估真实使用中的 UI/UX。区分用户反馈、截图事实、源码推导和需实机验证的假设；提出有证据的问题、连贯的改善方向和可检查的验收标准。不限定发现数量、不预设通过，不直接改代码或连接硬件。若只能读取部分内容，请明确缺少哪些证据，不假称已运行或验证。

本次仅发布源码及脱敏说明，不包含 `.git`、SDK、依赖、构建产物、真实账本/NVS、`backups/` 或本地会话目录。`main` 保持不变。
