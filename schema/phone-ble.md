# 手机 BLE 通信交接（协议 1）

> 固件 BLE 后端与可复用原生 ESM [`phone/ble-client.mjs`](../phone/ble-client.mjs) 已提供；[手机页面](../phone/index.html) 与 PWA 已完成 Mac 浏览器及主机回归，详见 [开发交接](../docs/development-handoff.md)。页面使用中文操作名称，设备诊断与错误码放在折叠详情中。Windows 原生 BLE 客户端加两台相机的三连接已做只读实测；真实手机浏览器尚未联调。BLE 没有应用层身份认证，附近能建立连接的客户端可操作拍摄与修改账本；设备选择框不是业务身份认证。仅在可信现场使用，不公开暴露控制权。

## UI 的业务边界

- ESP32 Flash 是现场主账，手机保存项目隔离的副本；`template_id` 是模板，`project_id` 是一次采集项目，不能互换。动作中文名、分组、点位说明/字典只存手机/电脑，MCU 仅保存 ID。
- 项目/模板/命令/开机 ID 最多 63 个 ASCII 字节；动作/点位 ID 最多 31 字节。允许字母、数字、`_-.`；未指定点位用空字符串。项目重置后不要复用旧项目 ID。
- **动作切换必须等待 SELECT_ACTION 成功 ACK，禁止先把界面显示成已切换。** ACK 表示命令接受/账本提交，不表示相机已经录像或已经停录。通过状态与 TAKE_END 证据展示实际结果，未知不能显示成正常完成。
- 没有 `expected_revision`。START 的 `command_id` 防重仅覆盖最新 TAKE_BEGIN；跨过更新 BEGIN 后重放旧命令可能重新拍摄。不要自动 START/STOP、重试、重连或无限重放命令。STOP 必须携带当前 `project_id,take_id`，避免误停下一段。
- RESET_PROJECT、EXPORT_LOG 仅 USB。模块不提供这些便利方法；`request({cmd:'RESET_PROJECT',...})` / EXPORT_LOG 仍会发往固件并以 `BleClientError.code === 'usb_only'` 暴露拒绝，`confirm:true` 不能绕过。BLE 备份用 syncLog；初始化不是重置。扫描/配对相机的串口文本命令不在手机 API 中。
- BLE START 的新 TAKE_BEGIN 使用 `source:'ble'`；手机应兼容 boot/usb/external/ble。事件细节见 [`events.md`](events.md)。

## 连接与分包

| 特征 | UUID | 操作 |
|---|---|---|
| Service | `749d1000-7fbe-4dbf-9f6a-307ca69c6bc5` | requestDevice 按此服务过滤 |
| RX | `749d1001-7fbe-4dbf-9f6a-307ca69c6bc5` | write with response |
| TX | `749d1002-7fbe-4dbf-9f6a-307ca69c6bc5` | indicate，浏览器 startNotifications 订阅 |
| INFO | `749d1003-7fbe-4dbf-9f6a-307ca69c6bc5` | read，UTF-8 JSON |

INFO 必须匹配以下协议限制；不匹配连接失败，不继续发送：

```json
{"protocol":1,"header_bytes":8,"max_command_bytes":767,"max_message_bytes":4096,"default_packet_bytes":20}
```

每个 RX/TX ATT value 都有 8 字节头，数字是无符号 little-endian：

| 字节 | 含义 |
|---|---|
| 0 | 协议版本 1 |
| 1 | kind：COMMAND=0，REPLY=1，STATUS=2，LOG_BEGIN=3，LOG_EVENT=4，LOG_END=5 |
| 2–3 | request_id：1..65535；仅主动 STATUS 使用 0 |
| 4–5 | offset：本片在完整 JSON UTF-8 字节串中的位置 |
| 6–7 | total：完整 JSON UTF-8 字节数，不含头 |
| 8.. | 连续 JSON 字节片段 |

默认 ATT value 20 字节，对应最小 MTU 23，每片净载荷 12 字节。UTF-8 字符可以跨片；必须先重组再解码。COMMAND 完整内容 1..767 字节，其他消息 1..4096 字节。总长、偏移、kind/request_id 必须一致，offset 从 0 严格连续，不允许空片、越界、重复、乱序或逻辑消息交织。一个日志 EVENT 是一个独立完整 JSON 消息，即便 request_id 相同，也重新从 offset=0 开始。日志原始行的 LF **不在线上传输的 EVENT 内容中**。

模块默认 `writeValueWithResponse`，绝不退化为无响应写。`packetBytes` 可显式配置 9..512，但 Web Bluetooth 不提供可移植的 MTU 协商查询；未实测不要调大，20 是可互通基线。完整命令分片严格串行；普通命令还等待前一个回复。GET_LOG 完整请求写出后不独占命令通道，日志传输/异步存储期间仍可发送 STOP/状态查询。

## JS API

```js
import { DjiBleClient, BleClientError, UUIDS, KINDS,
  encodeMessage, MessageReassembler } from './phone/ble-client.mjs';

const client = new DjiBleClient({
  timeoutMs: 15000,
  packetBytes: 20,
  maxEventBacklog: 32,
  onStatus(status) { console.log('设备快照', status); },
  onConnection({ connected, error }) { console.log('连接状态', connected, error); },
  onError(error) { console.error('通信/回调错误', error); },
});

// 连接按钮必须在点击处理器中直接调用 connect()，不要先等待其他业务。
export async function connectFromUserGesture() {
  await client.connect();
  const status = await client.getStatus();
  await client.syncTime(); // Date.now()；不会触发拍摄
  return status;
}

export async function selectAction(projectId, actionId, pointId = '') {
  // UI 在此 Promise 成功之后才更新“已选动作”。
  return await client.request({ cmd: 'SELECT_ACTION', project_id: projectId,
    action_id: actionId, point_id: pointId });
}
```

| API | 返回/约束 |
|---|---|
| `new DjiBleClient(options)` | 可注入 Web Bluetooth 对象供测试；默认 navigator.bluetooth。timeoutMs 默认 15000，maxEventBacklog 默认 32（1..256） |
| `connect()` | 用户手势触发设备选择，连接、读 INFO、订阅 TX，返回 INFO；不自动发命令 |
| `disconnect()` | 主动关闭，所有未完成/排队请求立即失败；不自动重连 |
| `connected` | 当前连接是否完成准备 |
| `request(commandObject, {timeoutMs}?)` | JSON 命令对象，返回成功 REPLY；`ok:false` 拒绝。GET_LOG 必须使用 syncLog |
| `getStatus(options?)` | 等价 GET_STATUS |
| `syncTime(utcMs=Date.now(), options?)` | TIME_SYNC，UTC Unix 毫秒 |
| `syncLog(afterSeq, projectId, async onEvent, options?)` | 返回 `{after_seq,snapshot,sent_lines,sent_bytes}`；回调为 `(event,{project_id,after_seq,raw})`，raw 是无 LF 的原始 UTF-8 字节副本 |
| `encodeMessage(kind, requestId, objectOrBytes, {packetBytes=20}?)` | 返回 Uint8Array 分片数组；bytes 输入保留原始字节，不重新序列化 |
| `new MessageReassembler().push(bytesOrDataView)` | 未完成返回 null；完成返回 `{kind,requestId,data,bytes,text}`；非法数据清空重组状态并抛错；可 reset() |

`onStatus` 接收主动 STATUS 快照，可返回 Promise；慢回调期间只保留最新一条待处理快照，不累积过时状态。`onConnection` 接收 `{connected,deviceId? ,error?}`；回调不是连接成功的唯一依据，调用者仍必须 await connect。`onError` 是诊断通知，不替代请求 Promise 的 catch。回调抛错/拒绝会报告 `callback_failed`，不会成为后台未处理拒绝；onError 自身失败写 console.error。状态回调与日志存储、命令响应互不等待。

主动 STATUS 约每秒一次，仅在发送队列空闲且没有日志流时生成。日志同步期间可能暂停主动状态推送，但仍可主动 GET_STATUS/STOP；只读实测确认状态查询回复可先于 LOG_END 到达。UI 应依据本地最后接收时间标记状态陈旧，不得把长期未更新的 recording=false 当作安全空闲。

request_id 自动递增且同一连接内不复用；65535 个 ID 耗尽后返回 `request_ids_exhausted`，需要调用者显式重连。待处理请求上限 32。旧连接监听器、未完成分片和排队写均不会跨连接继续执行。

## 命令与状态字段

| cmd | 参数/限制 |
|---|---|
| INIT_PROJECT | project_id,template_id；空项目且相机安全空闲时初始化；已有项目重置只经 USB |
| SELECT_ACTION | project_id,action_id,可选 point_id,target_cameras；目标为整数 1=A、2=B、3=双机；省略目标时保留当前值，持久提交后 ACK；拍摄中拒绝修改 |
| TIME_SYNC | utc_ms；当前 boot 时间锚点，不保证手机时钟准确 |
| START | project_id,command_id，可选 target_cameras 作为已确认选择的校验；不匹配返回 target_mismatch；仅最新 BEGIN 防重，重复不会再启动 |
| STOP | project_id,take_id；显式用户操作；日志流进行时允许；结案后仍报告录像时，匹配最新编号可安全停止，不修改已提交 END |
| MARK_DISCARD | project_id,take_id,discard（布尔）；标废/取消 |
| REASSIGN | project_id,take_id,action_id,可选 point_id；修改已结束拍摄归属，不改 take_id |
| GET_STATUS | 无额外参数；当前实时快照 |
| GET_LOG_INFO | 无额外参数；主账项目与统计 tuple |
| GET_LOG | project_id,after_seq；仅 syncLog 使用，0<=after_seq<=当前 event_seq；允许拍摄期间同步 |

ACK 包含 `ok`、项目/模板/动作/点位身份、已提交 `event_seq,take_id`；失败带 `error` 字符串。GET_LOG_INFO tuple 是 `project_id,template_id,event_seq,take_id,lines,bytes`，bytes 包含每行 LF。GET_STATUS/主动 STATUS 的业务快照字段包括：

- `project_id,template_id,action_id,point_id,event_seq,take_id,active_take_id,phase,boot_id,mono_ms,time_synced,writable,free_bytes,target_cameras,active_participants`，以及存储诊断 `storage_error`；空间无法获取时 free_bytes 可能缺失。take_id 是最新永久编号；active_take_id 在空闲时为 0，不能仅凭 take_id 非零认为正在录制。`target_cameras` 是持久配置意图，1=A、2=B、3=双机；`active_participants` 是活动段已准入的掩码，空闲为 0，不表示这些相机已确认录上。
- phase 为 idle/starting/recording/stopping/closing。没有时间锚点的 boot 必须允许“时间待确认”，不能编造 UTC；仅相同 boot_id 的单调时间可以直接比较。
- `cameras` 固定 A、B 顺序，每项含 `connected,fresh,recording,record_time,battery,led,video,sleeping,status_age_ms,ready`。状态失联/陈旧不能用 recording=false 当成已确认停录；record_time 保留原始值，不擅自推定单位。

### 选机与固件能力

所有控制 ACK、GET_LOG_INFO 与 STATUS 返回 `target_cameras`，STATUS 另有 `active_participants`。手机切换相机时与动作、点位一起发 SELECT_ACTION，收到设备成功确认的有效目标后才高亮；发送 START 必须附上已确认目标。对缺少有效实时目标/参与字段的旧固件，不应猜测它支持选机：禁用选机与新 START 并说明需要支持该功能的固件，保留已有活动录像的 STOP。这与历史日志缺字段的恢复规则是两回事。

手机与 BOOT 都要求所选目标全部就绪；双机不足时拒绝开始，需显式切单机。未选相机未连接、休眠或陈旧本身不阻塞所选机，但任何已连接相机报告正在录像仍否决新受控拍摄。错误目标类型（包括 bool、null、字符串、小数）或 0/>3 返回 invalid_request；目标与已提交选择不符返回 target_mismatch。有效的最新 command_id 重复返回原编号，不产生第二段。拍摄期间禁止切换目标；外部录像仅改变本段参与证据，不改变配置目标。

## 快照日志与逐事件持久化

GET_LOG 的所有消息使用同一 request_id：

1. LOG_BEGIN：`{project_id,template_id,event_seq,take_id,lines,bytes,after_seq}`。tuple 冻结在流开始时；lines/bytes 是**整个快照**，不是本次增量。新追加事件不属于该流。
2. LOG_EVENT：原始 JSONL 的一个事件对象去掉尾 LF，序号必须从 after_seq+1 连续增长，project/template 必须匹配 BEGIN。
3. LOG_END：`{ok,project_id,event_seq,through_seq,sent_lines,sent_bytes}`。through_seq 必须等于 BEGIN 上界；sent_lines 是本次增量条数，sent_bytes 是本次原始 UTF-8 行字节数加每行一个 LF，不是 JSON.stringify(event) 的字节数。

客户端校验首尾身份、上界、顺序、逐行字节和计数。全量 after_seq=0 还必须与快照 lines/bytes 完全相等；增量不得超出完整快照字节数。空增量仍需 BEGIN/END，不能靠“没收到事件”判断同步完成。USB 重置/项目切换、读错或断开会终止流；第二个流返回 log_busy。

**onEvent 必须在事件保存成功后才 resolve。** 模块按回调完成顺序推进内存游标，不允许 fire-and-forget。沿用 V1 的 localStorage 副本方案时，先写事件，后写项目游标；两次 setItem 不是同一事务，但中断只能造成重复续传，不能让游标越过未保存的事件。按 `(project_id,event_seq)` 幂等保存，重复键内容不一致则报错，不覆盖：

```js
// 与前面的 client 放在同一个 ESM 中；这是存储接入示例，不包含 UI。
const utf8 = new TextDecoder('utf-8', { fatal: true });
const prefix = projectId => `dji-ledger:${encodeURIComponent(projectId)}:`;
const eventKey = (projectId, seq) => `${prefix(projectId)}event:${seq}`;
const cursorKey = projectId => `${prefix(projectId)}cursor`;

function readCursorValue(projectId) {
  const n = Number(localStorage.getItem(cursorKey(projectId)) ?? '0');
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid local cursor');
  return n;
}

function loadCursor(projectId) {
  const claimed = readCursorValue(projectId);
  for (let seq = 1; seq <= claimed; seq++) {
    const raw = localStorage.getItem(eventKey(projectId, seq));
    if (raw === null) return seq - 1; // 缺项只从连续前缀恢复，不盲信旧游标。
    const event = JSON.parse(raw);
    if (event.project_id !== projectId || event.event_seq !== seq) {
      throw new Error('Invalid cached ledger identity');
    }
  }
  return claimed;
}

async function persistEvent(event, { after_seq, raw }) {
  const key = eventKey(event.project_id, event.event_seq);
  const text = utf8.decode(raw); // 保留原始 JSON 字节对应的文本，不重新 stringify。
  const previous = localStorage.getItem(key);
  if (previous !== null && previous !== text) throw new Error('Cached event conflict');
  localStorage.setItem(key, text); // 配额/权限异常直接抛出，不能继续推进游标。
  const next = Math.max(readCursorValue(event.project_id), after_seq);
  localStorage.setItem(cursorKey(event.project_id), String(next));
}

export async function syncCurrentProject() {
  const status = await client.getStatus();
  if (!status.project_id) return; // 未初始化项目不建立本地项目主键。
  const afterSeq = loadCursor(status.project_id);
  try {
    return await client.syncLog(afterSeq, status.project_id, persistEvent);
  } catch (error) {
    console.error('同步中断，最近确认存储的游标', error.after_seq, error);
    throw error;
  }
}
```

同项目禁止多个本地写入器并发推进游标。浏览器配额、用户清理和回收可能丢失副本，不能取代 ESP32 主账及电脑 USB 备份；setItem 成功也不代表操作系统掉电后绝不丢失。若改用异步事务存储，必须等待事务完成；断开不能取消已经开始的事务，错误游标可能保守停在之前确认值。下次以本地实际连续前缀为准，允许安全重放，不使用失败 END 的 through_seq。任何缓存冲突/损坏都应显示错误，不能自动重置设备项目。

## 错误和超时

- 每次 request/syncLog 都必须 catch。`BleClientError` 有 `code`，设备拒绝附 `reply`；日志失败附 `after_seq`（最后确认 onEvent 成功的位置），不要用 through_seq 覆盖它。connect 的浏览器权限/设备选择错误、存储错误保留实际异常信息/原因链，不伪造成功。
- timeoutMs 是排队等待/当前 I/O 的**无进展超时**：排队开始计时，每次成功分片写、合法响应分片、完成持久化都会刷新。总同步可超过 timeoutMs；存储回调长期不完成也会超时。
- 尚未开始写的排队请求超时直接移除，绝不迟到执行；正在写/等待响应/流中的请求超时会断开会话，防止半包、迟到回复和队列污染。已完整送出的变更是否生效可能未知，先读状态/同步主账，不自动重发。
- 协议损坏、外来 request_id、错序/外项目事件、异常 END、异步事件积压超限会中断连接并拒绝所有待处理请求。事件积压默认最多 32 个消息、至多对应 32×4096 字节，包含正在处理的消息；宁可显式中断并保守续传，不静默漏事件。
- 连接断开清空所有分包与排队任务；旧会话数据不参与新会话相关性。没有后台未处理的模块内部写/存储 Promise；调用者自己的 request/connect Promise 仍需处理。

## 部署和浏览器现实

通过 HTTPS 静态托管原生 ESM（正确 JavaScript MIME）并保持相对路径；不需要 ESP32 Wi-Fi、file:// 或后端业务服务。开发 localhost 的安全上下文仅指浏览器所在设备，手机访问电脑普通 HTTP IP 不等价。connect/requestDevice 必须来自用户手势，不能先做长时间异步业务再弹选择器；嵌入页面还受 Permissions Policy、权限与可见性限制。

优先评估支持 Web Bluetooth 的 Android Chromium 浏览器；先检测 `navigator.bluetooth`，再检查权限、系统蓝牙与设备可见性。iOS Safari/普通 iOS PWA 不应被假设支持 Web Bluetooth，桌面/其他浏览器也存在平台、实验开关和策略差异。安装 PWA **不会补出蓝牙 API 或后台保活能力**。切后台、锁屏、系统省电可能断连；前台运行、显式恢复连接、重新读取状态后从本地项目游标续传。离线缓存、Service Worker 和安装清单现已实现；Mac 独立 Chrome 在关闭进程、关闭本地服务器后能离线重开，但真实手机安装入口、HTTPS 和前后台 BLE 尚需单独验收。

自动化入口 `node --test tests/test_phone_client.mjs` 的 26 项测试已通过，C3 固件已真实编译并刷入。Windows 原生 BLE 第三端与两机同时连接时，通过 GET_STATUS、完整/空增量日志、断开重连、733 字节命令的 20 字节分片及 USB-only 限制验证；设备原有 7 条/5737 字节主账逐字节保留，没有发 START 或修改相机素材。原始私有证据见 `backups/phone-ble-readonly-verification.json`。这不等于 Web Bluetooth 手机实测；真实手机连接、长流背压、前后台切换仍需 UI 集成后安全验收。
