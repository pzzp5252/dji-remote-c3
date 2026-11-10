# 换电脑继续开发：当前检查点

更新：2026-11-10。此检查点用于在 Mac 上继续开发，**不是已完成或正式发布版本**。

## 先看这几条

- 私有仓库：`https://github.com/pzzp5252/dji-remote-c3`，需要有访问权限的 GitHub 账号。
- 手机 UI 面向现场非技术操作员。用户明确拒绝研发术语、括号英文变量名、调试面板式布局和花哨状态标签。后续不能把这些文案改回去。
- 固件、页面与电脑工具的源码需要一起保存；只复制 `phone/` 不足以恢复整个项目。
- 原机的 `/tmp`、智能体会话、本机工具链、Orca Run/Dispatch ID 不随 GitHub 迁移。本文件替代这些临时上下文；Mac 不要复用 Windows 的终端或任务 ID。
- 不需要为了换电脑重新烧录、擦除 Flash、清空项目或重新配对相机。

## 已实现与已验证的边界

### ESP32-C3 固件与通信

代码在 `main/headless/`、`ble/`、`schema/` 与 `phone/ble-client.mjs`：拍摄状态机、LittleFS 五类事件主账、USB 管理、手机 BLE 服务端与原生 ESM 客户端。

既往固件构建、刷入与真实双机短拍/只读 BLE 验证记录见 `docs/headless-c3.md`、`CHANGELOG.md`。不能把这些既往结果当作新手机页面的实机验收。

### 电脑工具

- `tools/convert_actions.py`：CSV / XLSX / DOCX 转动作清单。
- `tools/usb_manage.py`：查看状态、原始日志导出、备份 tuple 核对后安全重置；实际串口需要 `pyserial`。
- `tools/match_media.py`：A/B 独立时钟校准、单调匹配、废片参与时间线、最终归属编号、不确定素材待确认。
- `tools/archive_project.py`：只读原片并复制归档，`_废片备查/`、`_待确认/`、`_台账/`，保留旧映射，同名冲突不覆盖，标准库生成三表 XLSX。
- `tests/test_archive_pipeline.py`：**16 项行为测试已在本机通过**。包含转换、模拟串口、匹配、归档、分文件、段号、修订、重复运行、冲突和工作簿内容。
- 复制验证只检查精确大小与 MP4 容器元数据，不是全文哈希、视频解码或真实相机时间含义的证明。原片绝不能删除或修改。

### 手机页面

文件：`phone/index.html`、`phone/styles.css`、`phone/app.mjs`、`phone/ble-client.mjs`。页面无构建步骤、无外部 CDN。

协调器曾对较早修订进行真实浏览器模拟操作，验证连接、数字搜索、动作确认前不提前更新、开始/停止、更新记录、弃用/恢复、修改拍摄内容、备份结构、控件焦点/草稿跨定时与状态更新保持、导入文本不作为 HTML 执行。

随后 native `agy` 又按用户要求修改了文案、主次层级、未连接相机卡片、占位提示、搜索帮助、备份按钮及演示存储隔离。智能体屏幕上已说明实现，但其汇报命令卡住，**这一最新修订还没有完成协调器浏览器验收**。不要把较早的浏览器结果算到最新页面上。

## 用户要求的 UI 验收标准

必须整页处理，不是任选一张卡片：

1. 主界面使用正常中文业务词汇，不显示 ACK、落盘、SELECT_ACTION、idle、JSON、record_time、battery、project_id、template_id、游标、时钟锚点、可写状态、主账、改归属等调试语言。原始错误码与必要证据保留在默认收起的详情中。
2. 主要操作：连接遥控器、选择拍摄内容、开始录像、停止录像、查看已拍记录。当前拍摄内容与录像按钮最突出；备份、帮助、诊断不抢主操作的视觉注意力。
3. 输入框不预填看似真实的示例编码；占位提示浅色、较小、聚焦后隐藏，不改输入值，不引起布局跳动。项目编号与拍摄清单编号分清楚。
4. 相机未连接时只显示简洁状态，不堆零值、横线、重复“未连接”，不显示硬件引脚名或 LED 数字映射。连接后显示电量和是否能拍。
5. 搜索框简洁，数字搜索规则放入小型、默认收起的搜索帮助。分组、静态/动态、未拍/已拍筛选不能丢。
6. 备份按钮降低视觉权重，但触控区域仍至少 48px。明确备份是拍摄记录，不包含相机视频。
7. 状态必须诚实：设备确认保存后才显示已保存；相机实际确认录像后才显示正在录像；状态过期、失联和未知不能冒充就绪或已停止。开始期间允许用户停止。
8. 明暗主题、375px 手机和桌面布局、单色 SVG、48px 控件、无布局抖动、无 Emoji 结构图标。
9. 演示页面标明“不会连接真实设备”，使用独立模拟身份和存储，不读写实际项目账本；显式注入的 storage 仍可用于测试。
10. 真实设备的原始日志先保存事件再推进游标；按项目隔离、断线后增量恢复；不自动重试录停、不自动重连、不清空设备。

命名参考：更新拍摄记录、导入拍摄清单、不用这段/保留这段、修改拍摄内容/保存修改、复制备份/分享备份/保存备份文件。修改的是片段对应的动作与位置，**不是把它搬到另一个项目**，不能用文案混淆身份。

## 尚未完成：按这个顺序继续

### 1. 验收最新页面

先在浏览器打开真实页面与 `?mock=1`，按上面的整页标准检查。覆盖未连接、连接、等待确认、录像、停止、记录修改、失败提示与折叠详情；检查闭合详情真的不绘制内部诊断文字。验证明暗主题、375px 手机和桌面、没有横向溢出，控件与修改草稿不会被周期状态更新重建。

本机无头 Chromium 缺少中文字库，截图出现方框是测试环境限制；Mac 应使用可正常显示中文的浏览器验收。Windows Orca 的 viewport 设置曾在后续动作中重置成面板尺寸，因此不要只信设置成功，要核对实际 `innerWidth` 与截图。

### 2. 完成 PWA 与手机行为测试（原计划 Step 4）

目前 **`phone/manifest.webmanifest`、`phone/sw.js`、`tests/test_phone_ui.mjs` 都尚未交付**。

- Manifest：名称“ 双机录像控制与场记系统 ”为原计划名称，可按当前纯中文产品名称一致化；standalone、相对 start_url、主题色 #0B0F17、自包含图标，不依赖外网。
- Service Worker：版本 `dji-field-ui-v1`；预缓存页面、样式、app、BLE 客户端、manifest、`../schema/actions.json`；同源静态 Cache-First + 后台更新，断网可打开；背景更新失败不可产生未处理拒绝。
- 页面关联 manifest，安全上下文下注册 SW。手机访问电脑的普通 HTTP 局域网地址不等于 HTTPS，PWA 不会补出浏览器原本没有的蓝牙能力。
- 保留 `createApp({root, client, storage, fetchImpl})` 注入与确定性模拟控制器。
- Node `node:test` 测试模板/分组/类别/未拍已拍/数字27、动作确认前后、录像时禁止切换、录停状态、断线增量恢复、弃用恢复与修改内容、账本及计数、完整备份结构。
- 还需覆盖草稿与焦点跨状态/定时更新、用户文字按纯文本显示、演示存储隔离等本次实际缺陷。
- 不要写源码文本、固定文案、转发接线或 mock 回声类永久测试。

### 3. 最终统一回归与硬件验收边界

`tests/run_host_tests.sh` 已引用尚未存在的 `tests/test_phone_ui.mjs`；因此当前整个入口**不能当作已通过**。不要为了变绿而跳过这行，先完成手机测试。

完成后运行完整主机套件，再做浏览器离线、交互和布局验收。真实手机 Web Bluetooth、相机 MP4 创建时间含义、长时间/异常现场操作仍需单独实测；不能由模拟器代替。

## Mac 上先看页面

```sh
git clone https://github.com/pzzp5252/dji-remote-c3.git
cd dji-remote-c3
# 如果检查点保存在迁移分支，先 git switch <实际分支名>
python3 -m http.server 8080
```

电脑浏览器打开 `http://localhost:8080/phone/?mock=1`。这是演示，不会控制实际相机。开发页面本身不需要先安装 ESP-IDF。

可用检查：

```sh
node --test tests/test_phone_client.mjs
python3 -m unittest discover -s tests -p test_archive_pipeline.py
```

本机验证环境为 Python 3.14、Node 24。Mac 需自行安装 Python、Node；完整 C 主机测试还需要 clang 与 cJSON，固件开发需要 ESP-IDF 5.5.2/ESP32-C3 工具链，按 `docs/headless-c3.md` 配置，不要复制 Windows/WSL 的绝对路径或构建缓存。

Mac 的 cJSON 若由 Homebrew 安装，可在手机测试交付后用：

```sh
CC=clang \
CJSON_CFLAGS="-I$(brew --prefix cjson)/include/cjson" \
CJSON_LIBS="-L$(brew --prefix cjson)/lib -lcjson" \
sh tests/run_host_tests.sh
```

这条 Mac 命令尚未在 Mac 实机运行，不是已验证结果。

## 携带与备份

- 带遥控器、两台相机、原存储卡、可传数据的线；离开前确认相机已停止录像。
- GitHub 保存源码与交接，不保存相机视频或板内主账。
- `backups/`、`build-c3/`、`managed_components/`、本机 `sdkconfig.c3`、Python 缓存被 Git 排除。若需要原机私有 Flash/日志备份，另行复制到自己控制的安全存储，不要公开上传。
- 板子断电不等于擦除 Flash，但不要执行 `erase-flash`、RESET_PROJECT 或格式化来“重新开始开发”。重新连接后先读取现有状态和备份。
- GitHub 不迁移智能体登录、技能安装、权限、会话和 `/tmp` 文件；在 Mac 新会话先让智能体阅读本文件和相关 schema。

## 原 Windows 编排故障（勿误诊为模型不会汇报）

Native `agy` 确实构造了 `worker_done` 命令，但 WSL→PowerShell 的 Orca CLI 子进程曾让无等待 check 与完成 send 挂起。协调器只结束了挂起的查询/汇报子进程，保留会话与文件。最新 UI 汇报未确认送达，不据此宣称验收完成。

`agy` 专用目录只发现设计类技能；共享 `.agents/skills` 有 Orca 技能，是否被 native agy 扫描尚未确认。在 Mac 重新确认技能与 Orca CLI；若使用 agy，用户要求命令包含 `--dangerously-skip-permissions`，但仍必须遵守本项目文件范围、不可操作原片/清账和真实设备安全约束。实际接口以 Mac 上安装版本的技能文档为准，不能照搬旧 Run/终端句柄。
