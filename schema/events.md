# V1 拍摄主账契约

ESP32 Flash 是现场唯一主账。版本 `schema_version=1`，UTF-8 JSONL，每行一个已提交事件，行末 LF。手机副本按 `project_id` 隔离、按 `event_seq` 去重。中文动作字典只在手机与电脑保存。

## 身份与时间

- `template_id` 标识动作模板；`project_id` 标识一次验证项目，两者不能混用。同一模板可对应多个项目。ID 仅允许 ASCII 字母、数字、`_-.`，项目/模板/命令/开机 ID 最多 63 字节，动作/点位 ID 最多 31 字节。空点位表示未指定。
- `(project_id,take_id)` 唯一标识拍摄；`take_id` 从 1 连续分配，废片、补拍、跨天不重置。`event_seq` 从 1 递增。仅正式 RESET 后归零。
- 所有事件包含 `schema_version,project_id,template_id,event_seq,type,boot_id,mono_ms,time_anchor`。`mono_ms` 为 64 位单调毫秒；`boot_id` 每次开机随机生成。`time_anchor` 为 null 或 `{boot_id,mono_ms,utc_ms}`，只随离散事件落盘。
- 仅同一 boot_id 的单调时间可比较；UTC 可由同 boot 的锚点换算。一个 boot 没有锚点时，电脑必须允许进入“待确认”，不能编造 UTC 或强制匹配。晚到锚点可用于同 boot 早期事件。

## 五类事件

| type | 额外字段 | 约束 |
|---|---|---|
| SELECT_ACTION | action_id, point_id | 提交后才 ACK；拍摄中拒绝切换 |
| TAKE_BEGIN | take_id, command_id, action_id, point_id, source, participants | source 为 boot/usb/ble/external；participants 为 A/B 位掩码；持久提交成功才发 START |
| TAKE_END | take_id, action_id, point_id, begin_boot_id, begin_mono_ms, reason, complete, cameras | 结案不等于两机停止；逐机证据决定正常/异常 |
| MARK_DISCARD | take_id, discard | 布尔值；true 标废，false 取消标废 |
| REASSIGN | take_id, action_id, point_id | 结束后修改归属，不改 take_id |

`TAKE_END.cameras` 固定为 A、B 顺序的两个对象，包含参与标记、开始/停止派发结果与时间、首次/最后录像观察、最后相机原始计时、停止确认、失联/重连/状态过期/意外停录/重新录制证据及最终状态。未观察到的时间为 null；相机计时保存原始值，不在未实测前假定精度或计时单位。

逐机字段名与含义：

| 字段 | 类型/含义 |
|---|---|
| participating | bool，是否参与本次开始；false 表示未参与/未就绪，不会自动补发 START |
| start_sent / start_failed / stop_sent / stop_failed | bool，仅代表派发结果，不代表相机执行成功 |
| start_ms / stop_ms | 单调毫秒或 null，实际调用逐机异步接口前的时间 |
| seen_recording / first_record_ms / last_record_ms | 是否观察到录像及首次/最后 1D02 观察时间 |
| stop_confirmed / stopped_ms | 是否获得空闲确认及对应观察时间；未知不得记为已停止 |
| last_sample_ms / record_time / battery | 最后有效状态时间、最后一次录像中状态的原始计时、电量百分数；停录后的计时清零不覆盖录像计时证据 |
| disconnected / reconnected / disconnect_count / reconnect_count | 过程失联/恢复证据及次数 |
| stale / unexpected_stop / restarted | 是否发生过状态过期、意外停录、停后再录；历史证据不随恢复清除 |
| unknown / final_connected / final_recording | 当前未知、结案时连接与最后已知录像位；unknown=true 时不能把录像位 false 解释为确认停止 |

END 的 `observation_lost` 表示过程证据不完整；`complete` 仅在参与相机正常确认录停、无失联/异常/证据缺口时为 true。超时、取消、外部意外结束与掉电恢复均保留异常结案原因。

掉电后，已提交 BEGIN 无 END 的拍摄恢复为结束未知、过程不完整，并追加异常 END；保留原 BEGIN 的 boot 与单调时间。日志残缺尾行在继续追加前截断；中间损坏必须报错，不能跳过后继续编号。

## 防重与启动条件

只在 RAM 保存最新 TAKE_BEGIN 的 command_id 与 take_id；开机扫描恢复时同时恢复该值。START 防重仅比较这一条，不为请求扫描历史日志；相同命令返回原编号。旧命令跨过更新的 BEGIN 后不保证防重，客户端不得无限期重放。

新 BEGIN 必须满足：旧段已结案、没有已连接相机被观察为录像中、至少一台相机状态新鲜且确认空闲并可录像。仅对就绪相机发 START，另一台记录未参与/未就绪。等待 START 时 STOP 可立即打断；不会为此分配新编号。停止超时写异常 END，断连相机不会永久阻塞下一段；已连接相机收到新鲜空闲 1D02 后可清除未知。迟到或外部录像一旦被观察到，禁止作为空闲开启新段。

BEGIN 前检查 LittleFS 可用空间，除 BEGIN 自身外保留 8192 字节余量。空间不足拒绝新拍摄，不禁止停止、END 和导出。状态推送仅更新 RAM；无周期 Flash 检查点。

## 串口与部署

CH343P 使用 115200 8N1，机器命令为一行 JSON，响应也为 JSON。命令清单与可运行示例见 [C3 使用说明](../docs/headless-c3.md)。日志导出使用带首尾标记的原始 JSONL 区间；备份 tuple 为 project_id/event_seq/take_id/lines/bytes，字节数含 LF。RESET 必须提供完全匹配 tuple 与显式确认，只经 USB 开放；先持久切换新空项目，再清理旧文件，保留配对。

手机端通过 HTTPS 静态部署并安装 PWA 缓存；不依赖本地 file://、ESP32 Wi-Fi、手机后台保活或服务器业务后端。固件已提供手机 GATT 与无界面 ESM 通信模块，接口见 [手机 BLE 交接](phone-ble.md)。页面与 PWA 正在集成；电脑匹配器已提供，入口与保守匹配规则见 [电脑工具说明](../docs/headless-c3.md#电脑端模板usb-备份与视频匹配)。BLE GET_LOG 是非阻塞快照流，可在拍摄期间同步；USB 导出仍使用串口首尾帧且要求拍摄已结案。

文件名、精确大小、内部时间和时长是候选去重特征，不是内容唯一性证明。复制后大小一致、容器可读不等于全文无损；V1 不计算大视频哈希，不修改原片，歧义留待确认。
