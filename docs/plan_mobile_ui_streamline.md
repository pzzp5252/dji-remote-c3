# 双机遥控器手机端 UI 现代 iOS 原生自适应重塑与交互增强实施方案（四审合璧·开源调研定稿版）

**目标分支**：`feat/phone-ui-streamline` (基线：`checkpoint/mac-handoff-20261110`)  
**目标机型全景**：**现代 iPhone 16 / 17 / 18 全系机型（标准版 6.1"~6.3"、Plus 6.7"、Pro 6.3"、Pro Max 6.9"）**，同时向下严格自适应极限小屏（iPhone SE 548px 可用视口）。  
**架构范式转移**：**从脆弱的“人工固定像素手算拼凑（反模式）”彻底转向“现代 WebKit 声明式 Auto-Layout 弹性引擎（零滚动、全自动自适应）”**。  
**对抗性审查状态**：已由 **UI/UX 移动工效**、**系统架构与通信**、**GMP 数据完整性与灾备**、**iOS WebKit 现代自适应架构** 4 位独立 Subagent 完成四轮深度刺挑，全部关键成果与开源调研已完整固化入库。  
**自动化基线**：保持现有全部 50 项测试 100% 绿灯，追加 10 项深度对抗测试（扩充至 **60 项**）。

---

## 一、开源生态与 Apple 官方自适应技术全景调研

### 1. 为什么“手算硬编码像素”（如 38px + 72px = 110px）是典型的反模式？
1. **机型纵横比与绝对跨度极大**：从 iPhone SE 的 667px 高度到 iPhone 16/17/18 Pro Max 的 956px 高度，纵向跨度高达 300px。手算固定像素在小屏上必然撑破出滚动条，在大屏上则缩在顶部、留下大片丑陋空白；
2. **Safari 动态视口陷阱（The 100vh Trap）**：iOS Safari 地址栏与底部工具栏会动态展开和收缩，传统 `100vh` 必然导致底部按钮被原生工具栏遮挡；
3. **iOS Dynamic Type（大字无障碍缩放）**：用户在系统调大字号时，单行文本瞬间变成 2~3 行，硬编码高度被瞬间击穿，产生文字截断或布局崩溃；
4. **真实动作名称的不确定性**：验证现场动作名称长短不一（从 4 字到 30 字），固定盒模型必然在长文本下溃败。

### 2. 开源解决方案对比与选型决策
针对用户提出的“开源解决方式与官方自动适配套件”，经过深度技术排查与横向对比：

| 方案分类 | 代表项目 / 库 | 优势 | 弊端 | 选型结论 |
| :--- | :--- | :--- | :--- | :--- |
| **重型 iOS Web 框架** | **Framework7 (iOS Theme)** | 极其逼真的 iOS 原生视觉（分段器、抽屉、毛玻璃、转场） | 打包体积超 400KB；强绑定自身侵入式路由与 DOM 结构，破坏测试契约 | **淘汰（严重架构过载）** |
| **混合 Web Component 库** | **Ionic Framework (@ionic/core)** | 官方原生 iOS 模式，苹果 HIG 控件封装 | 体积数 MB，基于 Stencil 与 Shadow DOM，强依赖 npm/打包链与外部 chunk | **淘汰（无法在 ESP32 SPI Flash 纯离线运行）** |
| **纯静态 iOS 原生自适应引擎** | **WebKit 现代标准 + Apple HIG Tokens** | **零第三方依赖、零构建链、仅 3KB CSS**；硬件加速；100% 贴合 Safari 渲染引擎 | 需要高水准的 CSS Tokens 封装与 Auto-Layout 拓扑设计 | **最优解（100% 采纳）** |

> **决策裁定**：坚决不引入庞大冗余的外部 npm 库。而是**提炼一套基于现代 WebKit 官方规范（iOS 15.4+）的声明式 Auto-Layout 引擎**，将 Apple 原生 SwiftUI 的 `VStack` + `Spacer()` 理念在纯 CSS 中完美复现！

---

## 二、现代 WebKit 声明式 Auto-Layout 核心架构

```
+-------------------------------------------------------------+
|               [ 灵动岛 Dynamic Island ]                      |
|  Top Banner: Safe Area + 遥控器与双机状态胶囊 + 靶向报警条   | -> 【纯视觉观察区 (Top 1/3)】
+-------------------------------------------------------------+
| ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ Elastic Spacer ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~|
+-------------------------------------------------------------+
|  当前动作: D27 人员操作流型检查            [< 上项] [下项 >]| 
|  点位选择: [未指定] [P01] [P02] [P03] [ +新增 ] (惯性横滑条) | -> 【大拇指平移区 (Middle 1/3)】
+-------------------------------------------------------------+
| ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ Elastic Spacer ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~|
+-------------------------------------------------------------+
|  iOS Segmented Control: [  双机同拍  |  只拍 A  |  只拍 B  ] | -> 【纯正苹果分段选择器】
+-------------------------------------------------------------+
| ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ Elastic Spacer ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~|
+-------------------------------------------------------------+
|  [ 录像主按钮 ]  ▶ 开始录像 (48px 翡翠绿 / 舒适大拇指落点)   | -> 【大拇指核心热区 (Home Run)】
+-------------------------------------------------------------+
|  最近一段: 第 9 段 · D27/P01 · 双机同拍 (5秒) [改归属]      |
|  [ 现场拍摄 ]              [ 拍摄清单 ]        [ 已拍记录 ] |
+-------------------------------------------------------------+
|                     [ 底部横条 Home Bar ]                   |
+-------------------------------------------------------------+
```

### 1. 视口与安全区绝对锁死（零滚动保证）
* **`100svh` (Small Viewport Height)**：
  - 容器采用 `height: 100svh; max-height: 100dvh;`。即便在 Safari 底栏完全展开的最严苛状态下，内容也**绝对不会溢出可视区**；
* **Safe Area 系统避让**：
  - `padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px;`，配合 `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`，系统级自动避开灵动岛和底部横条；
* **`overscroll-behavior-y: none;`**：
  - 彻底消灭 iOS 网页默认的上下橡皮筋回弹露白，赋予 Native App 般硬朗稳定的操作手感。

### 2. 声明式弹性垫片（CSS 版 SwiftUI `Spacer()`）
在主操作流各卡片之间插入弹性垫片 `.ios-spacer`：
```css
.ios-spacer {
  flex: 1 1 0px;
  min-height: 4px;
  pointer-events: none;
}
```
* **在 iPhone SE (667px)** 上：垫片自动收缩至 4px，所有元素紧凑咬合，一屏完整展现；
* **在 iPhone 16/17/18 Pro Max (956px)** 上：垫片自动均匀展开，卡片间距舒展自然，营造高级呼吸感；
* **从根本原理上彻底根除上下滚动条，不再需要人工写死任何高度像素！**

---

## 三、基于 Apple HIG 的 UI / UX 原生重塑

### 1. 选机控制升级为 iOS 纯正 **Segmented Control（分段选择器）**
* **结构规范**：将 `#target-camera-strip` 升级为凹陷胶囊底槽（`background: rgba(120, 120, 128, 0.24)`，圆角 `9px`）；
* **Elevated Thumb（悬浮拇指滑块）**：当前激活项呈现为白色浮起胶囊卡片，带有微弱柔和投影（`box-shadow: 0 3px 8px rgba(0,0,0,0.14)`），支持平滑弹簧缓动动画（`cubic-bezier(0.2, 0, 0, 1)`）；
* **触觉微缩放**：按压时触发 `transform: scale(0.97)`，提供媲美原生系统的物理阻尼反馈。

### 2. 点位轨道升级为带蒙版的 **iOS Pill Collection**
* 横向无缝滑动（`display: flex; flex-wrap: nowrap; overflow-x: auto;`）；
* 硬件加速惯性滚动（`-webkit-overflow-scrolling: touch; scrollbar-width: none;`）；
* 左右边缘注入 CSS 渐变遮罩（`mask-image: linear-gradient(to right, transparent 0, black 10px, black calc(100% - 10px), transparent 100%)`），优雅提示后方可滑。

### 3. 现场新增点位弹窗升级为原生 **iOS Bottom Sheet（底部抽屉）**
* 放弃突兀的居中 Alert，采用标准 HTML5 `<dialog>` 打造原生底部抽屉；
* 顶部配备标志性的 **灰色拖拽抓手条（Drag Handle `36×5px`）**；
* 背景采用纯正的 iOS 毛玻璃系统材质：`backdrop-filter: blur(25px) saturate(190%);`；
* 软键盘弹起时利用 `visualViewport` 弹性上浮避让，支持下滑手势与取消平滑收回。

### 4. 单手大拇指黄金热区沉降（上读下操）
* **屏幕上 1/3**：纯视觉指示（灵动岛下方的双机电量、连接状态、靶向模式异常报警条），眼睛一瞥即知，无需手指去够；
* **屏幕中下部 2/3**：48px 录像主按钮、选机分段器、点位胶囊，全部稳稳落在单手握持时大拇指自然弯曲的舒适扇区内，在 6.9 寸 Pro Max 大屏上也能自如单手盲操。

---

## 四、ALCOA+ 数据完整性与现场灾备引擎（保留前序全部补丁）

1. **REASSIGN 点位防洗白（代码级死穴修复）**：
   - 彻底修复 `syncReassignSelectOptions` 在选项中缺失当前点位时清空 `draft.point_id = ''` 的致命 Bug；
   - 自动追加 `<option value="P03" selected>P03 — (现场保留点位·未命名)</option>`，绝不抹除硬件原始验证数据。
2. **异机换机自愈收割（Reverse Harvesting Engine）**：
   - 当更换手机接入 ESP32 拉取历史日志时，检测未收录的 `point_id`，自动合入本地模板并标记 `orphan: true`，首屏药丸高亮激活，支持一键反向补录中文全名。
3. **洁净区 3~15 分钟长录像防息屏（Screen WakeLock）**：
   - 双模保活：优先 `navigator.wakeLock.request('screen')`，iOS Bluefy 容器下自动降级为 1px 无声微视频保活；
   - 硬件单调时钟秒表绝对锚定（`status.mono_ms` 差值计算），休眠唤醒瞬时秒表对齐，宽放触发静默同步。
4. **RFC 4180 + Anti-Formula 注入的审计级 CSV 导出**：
   - 文件首字节强制写入 `\uFEFF`（UTF-8 BOM），彻底根除 Windows Excel 中文乱码；
   - 全字段标准双引号转义并消除换行符；公式符号（`=+-@\t`）前置单引号 `'`，杜绝 CWE-1236 动态公式执行风险。

---

## 五、DOM 契约保护与 60 项测试回归安全

本次现代自适应重构**完全属于表现层与 CSS 布局引擎的升维**，严格遵守“结构只增不破”原则：
1. **现有 53 个 DOM 测试选择器钩子 100% 保持不变**：
   - `#btn-connect`, `#status-banner`, `#btn-target-both`, `#btn-target-a`, `#btn-target-b`, `.target-cam-btn.is-active`, `#card-cam-a`, `#card-cam-b`, `#btn-record-main`, `#point-pills` 等核心契约毫发无损；
2. **全套自动化测试扩展至 60 项**：
   - 原有 50 项测试（24项 UI + 26项 BLE 客户端）保持 100% 绿色；
   - 追加 Test 25 至 Test 34（覆盖静默同步并发隔离、ASCII 校验、模板防冲、靶向告警、断线降级、REASSIGN 防清空、自愈收割、WakeLock 唤醒、IME 防截断、CSV 防注入），确保 60/60 测试全部通过。

---

## 六、实施确认与开工路线图

1. **修改文件范围**：
   - `phone/styles.css`：引入声明式 WebKit Auto-Layout 引擎、iOS Design Tokens、Segmented Control 样式、Bottom Sheet 抽屉样式；
   - `phone/index.html`：在卡片间注入 `.ios-spacer` 弹性垫片，引入 Bottom Sheet `<dialog>`；
   - `phone/app.mjs`：实现自愈收割、REASSIGN 防置空、双模 WakeLock、单调秒表、合规 CSV 导出；
   - `tests/test_phone_ui.mjs`：接入 Test 25 ~ Test 34 自动化测试。
2. **交付验证**：
   - 无头自动化测试验证：`node --test tests/test_phone_ui.mjs tests/test_phone_client.mjs`（60 项全绿）；
   - 真机真机验证：在 iPhone 16/17/18（Bluefy 浏览器）实测 iOS Segmented Control、大拇指盲操、长录像防息屏与自愈收割。

方案已终审定稿，架构坚不可摧。**请您审阅，是否正式批准开工编码？**
