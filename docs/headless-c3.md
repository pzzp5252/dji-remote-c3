# CORE-ESP32-C3 双机无屏幕遥控器

目标：合宙 CORE-ESP32-C3 **经典款**，USB 接口经 CH343P 连接 UART0，外置 4 MB Flash、DIO 模式、160 MHz。复用 DJI-Remote 的 BLE、协议、状态和控制层，仅对外开放相机槽 1、2；第三个内部槽保留以兼容上游数组。

硬件定义来自 [合宙官方板卡文档](https://wiki.luatos.com/chips/esp32c3/board.html)：BOOT 为 GPIO9（低有效），D4 为 GPIO12、D5 为 GPIO13（均高有效）。GPIO12/13 可作 LED 的前提是本板外置 Flash 并采用 **DIO**；不要拿此配置直接烧其他 C3 开发板。经典款使用 UART0 控制台，而非 USB Serial/JTAG。CH343P 驱动应在 macOS 系统设置中允许并启用。

## 使用

先用 USB 初始化项目并选择动作（下方 JSON 命令）。短按并松开 **BOOT** 创建拍摄，先提交 `TAKE_BEGIN` 再向就绪相机发 START；再次短按停止当前拍摄，包括仍等待 START 确认的情况。旧段结案后，只要没有已连接相机报告录像中，且至少一台相机状态新鲜、确认空闲、正常视频模式、未休眠，就可开始下一段；另一台记为未参与。未选动作、存储不足或旧段未结案时拒绝开始。

按键消抖 30 ms，松开才触发。开机时已按住的 BOOT 不触发录像；必须先松开。上电或复位时按住 BOOT 会进入 ROM 下载模式，因此日常使用先松开再复位。RST 始终仅作复位，不用于录像。

发送成功不是录像成功。逐机保存新状态确认、录像观察时间、原始录像计时、断连/恢复及意外停止/再录证据。开始确认超时不会反复 START；停止确认超时会提交异常 `TAKE_END`，不把未知状态写成已停止，也不因断连的 B 机永久阻止 A 机继续工作。连接中的相机恢复新鲜空闲推送后即可清除当前未知状态。无控制器上下文的外部录像记录为未归属动作的 external 拍摄。

失联后自动逐槽重试，包括遥控器先开机、相机稍后开机的情况。两次尝试至少间隔 5 秒；一次扫描、连接和认证可能耗时几十秒。重连工作在独立任务上进行，主循环仍处理按键、控制台和反馈。恢复连接后不会自动开始或续录。

D4 对应相机 1，D5 对应相机 2：

| 灯态 | 含义 |
|---|---|
| 熄灭 | 相机未连接 |
| 常亮 | 已连接、状态新鲜、正常视频空闲待机 |
| 慢闪，每秒一周期 | 已观察到录像 |
| 快闪，约 6.25 Hz | 等待开始/停止确认、未知、异常或未就绪 |
| 两灯快闪 3 秒 | BOOT 启动被拒绝 |

LED 是状态反馈，不是命令已发送的成功指示。

## 首次配对

使用 115200、8N1 串口终端。相机开机；关闭 Mimo 与其他遥控器的相机连接，以免占用 BLE 通道。

```text
help
scan
list
pair 1 1
{"cmd":"GET_STATUS"}
scan
list
pair 2 2
{"cmd":"GET_STATUS"}
```

`scan` 扫描 10 秒；`list` 中的索引从 1 开始。`pair <槽1或2> <list中的索引>` 明确选择相机，不会自动挑附近的设备。相机屏幕出现连接确认时，需在相机上同意。两槽不能重复配同一 MAC；已占用槽拒绝被直接覆盖。连接工作忙时需等待其结束再配对。

配对成功后保存 MAC、名称、机型标识；遥控器 ID 在首次启动随机生成并持久化，本机蓝牙 MAC 用作协议身份。连接使用 DJI 官方定义的历史感知模式 `verify_mode=0`：相机有记录时直接连接，无记录时要求屏幕确认，避免中断首次确认后反复强制配对。无本地记录时等待确认最多 60 秒，已有记录时最多 30 秒；直接连接请求和晚到 ACK 均保留正确序号，晚 ACK 不重置总等待期限。协议依据见 [DJI 官方连接流程](https://github.com/dji-sdk/Osmo-GPS-Controller-Demo/blob/main/docs/protocol_data_segment.md#connection-request-0019)。

NVS 读取或版本异常不会触发自动全片擦除。两台设置到普通视频模式，通过 `GET_STATUS` 检查。`debug` 开启 BLE／协议诊断，`quiet` 恢复正常日志；通常不需要开启诊断。

## 初始化、拍摄与管理

串口机器命令为单行 JSON，响应的 `ok` 表示请求已接受/日志已提交，不代表相机已开始录像。通过 `GET_STATUS` 检查实时状态，通过 END 核对实际结果。原来的文本 `start/stop/toggle/status` 已移除；配对仍使用 `scan/list/pair`。

```json
{"cmd":"INIT_PROJECT","project_id":"FZ3_202611_01","template_id":"CLEANROOM_SMOKE_V1"}
{"cmd":"SELECT_ACTION","project_id":"FZ3_202611_01","action_id":"D27","point_id":"P01"}
{"cmd":"TIME_SYNC","utc_ms":1794220000000}
{"cmd":"START","project_id":"FZ3_202611_01","command_id":"USB_001"}
{"cmd":"GET_STATUS"}
{"cmd":"STOP","project_id":"FZ3_202611_01","take_id":1}
{"cmd":"GET_LOG_INFO"}
{"cmd":"EXPORT_LOG"}
```

`TIME_SYNC.utc_ms` 应填写操作时真实 UTC Unix 毫秒；示例值仅演示格式，不应用于正式采集。时间锚点仅保存在 RAM，随后续离散事件落盘。新开机未同步时间的区间允许电脑端待确认。

| 命令 | 参数与限制 |
|---|---|
| INIT_PROJECT | project_id、template_id；无拍摄记录且相机安全空闲时初始化，二者独立 |
| SELECT_ACTION | project_id、action_id、可选 point_id；当前无活动拍摄，落盘后 ACK |
| START | project_id、command_id；仅比对最新 BEGIN 的 command_id，重试返回原 take_id，不扫描历史 |
| STOP | project_id、take_id；身份不符拒绝，防止迟到命令误停下一段 |
| TIME_SYNC | utc_ms；当前 boot 的时间锚点 |
| MARK_DISCARD | project_id、take_id、discard 布尔值；标废/取消标废 |
| REASSIGN | project_id、take_id、action_id、可选 point_id；修改已结束拍摄归属 |
| GET_STATUS | 项目、当前动作、拍摄阶段、A/B 状态、存储和同步状态 |
| GET_LOG_INFO | project_id、template_id、event_seq、take_id、lines、bytes；bytes 含 LF |
| EXPORT_LOG | 已结案时导出完整 JSONL，不清空项目 |
| GET_LOG | after_seq；已结案时增量导出 |
| RESET_PROJECT | project_id、event_seq、take_id、lines、bytes 和 confirm:true；必须与备份 tuple 完全相同，且无活动拍摄、所有在线相机确认未录像 |

完整导出区间为 `frame:LOG_BEGIN` 响应、原始 JSONL 行、`frame:LOG_END` 响应。仅保存中间 JSONL，按原始 LF 字节保存，校验有效行数、字节长度、项目 ID 和末尾序号与 BEGIN tuple 一致，且 END.ok 为 true 后才认为备份成功。导出期间持有 stdout 文件锁，防止其他任务的诊断混入；不要用会自动改写换行的终端保存方式。普通导出不清空数据，RESET 必须由操作者明确确认备份后发送。

LittleFS 是唯一主账，追加 flush/fsync 成功后才发布 RAM 状态。BEGIN 前除本行外预留 8192 字节；空间不足拒绝新拍摄，但不禁止停止/END/导出。1D02 通过有界队列更新 RAM，队列溢出标记证据不完整，不按推送频率写 Flash。掉电后重放日志并为未结案 BEGIN 追加 power_loss 异常 END；不跨 boot 拼接单调时间。残缺尾行安全截断，完整行损坏则停止写入，不跳过坏记录。

RESET 先提交新空代际与原子 manifest 切换，再清理旧日志，保留 NVS 配对。执行后需 INIT_PROJECT；已用过的项目 ID 不应复用。无清除配对、换槽、唤醒、GPS 或分辨率设置命令。

## 构建与烧录

使用 ESP-IDF **5.5.x**（CI 配置为 5.5.2）。先按乐鑫官方步骤安装 ESP32-C3 工具链并加载 `export.sh`，然后：

```sh
tools/headless/build.sh
```

此 Linux/WSL 开发机已安装完整 SDK、交叉编译器、Python 环境、CMake/Ninja 和 ROM 符号。无需重新下载，可在仓库根目录直接构建：

```sh
export IDF_PATH="$HOME/.espressif/esp-idf-v5.5.2"
export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.5_py3.14_env"
export ESP_ROM_ELF_DIR="$HOME/.espressif/tools/esp-rom-elfs/20241011"
export PATH="$IDF_PYTHON_ENV_PATH/bin:$IDF_PATH/tools:$HOME/.espressif/tools/riscv32-esp-elf/esp-14.2.0_20251107/riscv32-esp-elf/bin:$PATH"
export IDF_COMPONENT_CHECK_NEW_VERSION=0
tools/headless/build.sh
```

最后一个环境变量只关闭组件管理器对“可升级版本”的联网查询，仍使用并校验 `build-c3/dependencies.lock` 锁定的真实依赖；不是关闭组件管理器或替换 LittleFS 实现。

脚本使用独立的 `build-c3`、`sdkconfig.c3` 和 `build-c3/dependencies.lock`，不覆盖上游 GUI 的配置与锁文件。C3 编译排除所有屏幕、LVGL、GPS 和 WS2812 驱动。普通 GPIO LED 不需要 led_strip 依赖。

C3 使用独立 `partitions.c3.csv`：NVS 仍在 0x9000、factory 仍在 0x10000 且为 2 MiB；新增 0x210000 起的 0x1f0000 字节 LittleFS（约 1.94 MiB）。旧 `sdkconfig.c3` 若仍指向 partitions.csv，需在 menuconfig 的 Partition Table 中改为 partitions.c3.csv；默认配置仅作用于新生成的 sdkconfig。不要使用 erase-flash。

ESP-IDF 5.5.2 的隐藏 `ESP_WIFI_ENABLED` 是芯片能力标志，会保持 y，不能用 defaults 中写 n 把它当无线开关。本固件不调用 Wi-Fi 初始化/启动接口，仅运行 BLE；实际生成配置确认 `PM_ENABLE` 关闭。

只在新增日志分区经逐字节证明全为擦除态时自动首次格式化；损坏/非空分区挂载失败不会自动清空。首次升级前备份整片 Flash；若新分区含旧固件遗留数据，应先离线备份并由操作者明确决定如何初始化，不能把挂载失败当作允许删除旧日志。

**确认串口属于该板子、芯片与 Flash 容量正确，必要时先备份旧固件，再烧录。** 示意命令中的端口须替换成实际设备：

```sh
idf.py -B build-c3 -D SDKCONFIG=sdkconfig.c3 -p /dev/cu.wchusbserialXXXX flash monitor
```

不要向无关的 BillBoard/GSV-FWUPDATE 串口写入。若启用 CH343 驱动后仍无 USB 枚举，先排查数据线、接口和物理连接，不能靠刷固件修复未建立的 USB 数据通道。

## 验证与范围

主机策略回归测试：

```sh
tests/run_host_tests.sh
```

测试使用 C11、严格编译警告及 ASan/UBSan，覆盖 BOOT 消抖、逐机状态机、单机继续、取消开始、超时、外部录像、END 重试、日志恢复/损坏/写失败回滚/重置、命令身份与掉电恢复，以及手机分片协议、会话隔离、USB 权限限制和日志背压下的 STOP 分发。另有纯 Python MP4 探针测试及 26 项 ESM 客户端行为测试。主机需安装 Clang、cJSON 开发包（或设置 CJSON_CFLAGS/CJSON_LIBS）及 Node.js 24。这些测试不替代真实 LittleFS 掉电和无线链路验证。

本轮已在 Linux 主机以 Zig cc 0.17.1（C11、ASan/UBSan）执行控制/日志/命令及旧协议回归，并通过 15 项 Python 探针测试；另验证低空间准入边界及停止/导出不受 BEGIN 余量限制。实际 JSON 控制台烟测导出 3 条、1752 字节，核对首尾帧、精确字节数、错误备份 tuple 拒绝与确认 RESET。ESP-IDF 5.5.2 官方分区工具通过 4 MB 表校验。

本机已完成 ESP32-C3 应用、Bootloader 与分区表的真实编译和链接，并通过仓库 `tools/headless/build.sh` 入口复验。使用官方 ESP-IDF 5.5.2、RISC-V GCC 14.2.0（esp-14.2.0_20251107）、LittleFS 1.23.1；完整 SDK 归档的 SHA-256 与官方发布摘要一致。包含手机 BLE 接入的当前应用 629888 字节，2 MiB 应用分区余量约 70%；已通过 COM4 仅更新 0x10000 应用分区并核验写入摘要，未改写 NVS 与 LittleFS。

| 产物（build-c3 下） | 字节数 | 烧写偏移 |
|---|---:|---|
| dji_camera_bluetooth_control.bin | 629888 | 0x10000 |
| bootloader/bootloader.bin | 21104 | 0x0 |
| partition_table/partition-table.bin | 3072 | 0x8000 |

分区二进制核验通过：NVS 偏移 0x9000 保留，LittleFS 从 0x210000 起、大小 0x1f0000。按 `flasher_args.json` 分别写入上述文件，不使用会以填充字节覆盖 NVS 间隙的合并 raw 镜像。

P1/P2 阶段已在 Windows COM4 的 CORE-ESP32-C3 v0.4、4 MB 板卡完成刷写及设备侧写入摘要验证。保留原有两机配对，新 LittleFS 分区经确认原为擦除态后初始化。双 Action 6 自动重连，串口控制仅拍摄一次短测试；约 3.26 秒发送 STOP，两机随后均收到停止确认，BEGIN 到 END 的控制器时间约 5.36 秒。重复同一 command_id 未新增 take_id。该阶段主账为 3 条、2052 字节，完整导出与 GET_LOG(after_seq=2) 均核对通过。应用更新/重启后，项目、动作、点位、take_id=1、event_seq=3 恢复，日志逐字节一致，两机自动重连且未自动录像。

实机发现停录状态将录像计时清为零，导致旧汇总丢失最后录像计时。已修复为保留最后一次录像中状态的计时，通过 ASan/UBSan 回归、目标重编译并更新板端；为避免新增素材，修复后未再发 START。现存测试日志保留修复前事实，不回填计时。私有原始证据位于 `backups/hardware-test-log.jsonl` 与相关 JSON 记录中。

P1/P2 自动化验收未读取、下载、删除、重命名或格式化相机既有视频，仅由相机新增一次测试录像。视频文件内容、实体 BOOT/LED 目视效果、录制中异常掉电、满盘及长时间稳定性尚未实机验收。

P1/P2 阶段结束前已重新同步当次 boot 的 UTC 锚点（仅 RAM），测试项目与 take_id=1 保留，未执行 RESET_PROJECT。随后操作员通过 BOOT 新增两段；手机接入更新前后的主账均为 take_id=3、event_seq=7、5737 字节。

手机接入阶段已在同一块 C3 上完成双 Action 6 与 Windows 原生 BLE 客户端同时连接的只读验证：INFO/状态、完整及增量日志、20 字节 ATT 分片、断线重连、请求编号复用、USB 专属命令拒绝均通过。GET_STATUS 回复在日志结束前到达；BLE 导出与更新前备份、更新后 USB 导出逐字节一致，7 条事件未改变。Windows 蓝牙开关恢复原来的关闭状态，串口已关闭，最终两机连接、状态新鲜、空闲。本阶段未发送 START/STOP，也未访问相机素材；当前新 boot 尚无 UTC 锚点，手机连接后应先 TIME_SYNC。

手机接入证据保存在私有 `backups/phone-ble-readonly-verification.json` 与 `backups/phone-before-update-20261109T163249Z.jsonl`。这证明固件的三路 BLE 接入，不代表真实手机浏览器、后台切换或大项目长时间同步已验收。

以下为本次 P1/P2 改动前的旧版实机基线记录，不代表新固件已通过实机验收：2026-11-09 在 macOS 使用 ESP-IDF 5.5.2 与 RISC-V GCC 14.2.0 完成构建，应用 547792 字节，板为 ESP32-C3 v0.4、4 MB Flash，旧版主机策略、状态与 9 个握手场景通过。

旧版实机已完成：原有 4 MB Flash 备份、刷写；双 Action 6 首次确认与保存；串口/BOOT 录停；重启自动重连且不自动录像。本轮新状态机与日志功能的实机验证范围及未验证项以上述记录为准。

本轮刷写前整片 Flash 备份为 `backups/core-esp32c3-before-v1-journal-20261109T125115Z.bin`，同名 `.json` 保存字节数与 SHA-256。该目录已加入 git 忽略列表，固件分发包不包含备份、NVS 或私有串口日志。

固件构建由 `tools/headless/build.sh` 和 `.github/workflows/headless-c3.yml` 提供。**加入 CI 配置不表示 CI 已运行成功。** 长期稳定性、远距离、单台相机掉电恢复、完全冷启动及上游 ESP32／S3 带屏目标尚未验证。重启自动重连通过不代表上述条件均已覆盖。

一键录停通过两个 BLE 连接分别下发，不能保证视频首帧对齐或帧级同步。

## 在另一台电脑继续开发

项目仓库为私有仓库，先登录有访问权限的 GitHub 账号：

```sh
gh repo clone pzzp5252/dji-remote-c3
cd dji-remote-c3
```

安装 ESP-IDF 5.5.2 及 ESP32-C3 工具链，打开已加载 IDF 环境的终端后构建。Windows 的 ESP-IDF 终端也可直接运行：

```sh
idf.py -B build-c3 -D IDF_TARGET=esp32c3 -D SDKCONFIG=sdkconfig.c3 -D SDKCONFIG_DEFAULTS=sdkconfig.defaults.esp32c3_headless build
```

烧录时将上文示例端口替换为新电脑的实际串口（Windows 如 `COM5`）。仅拉取项目或构建不会修改板内配对信息；不需要执行 `erase-flash` 或重新配对。仓库不包含本机工具链、构建缓存、原机 Flash 备份、NVS 或串口日志。

当前源码包含 V1-P1 拍摄状态机、V1-P2 持久主账与 USB 管理、V1-P3 手机 GATT/状态通知/快照日志同步，以及可直接导入的 [Web Bluetooth ESM 客户端](../phone/ble-client.mjs)。[动作模板/事件契约](../schema/events.md)、[MP4 元数据探针](../schema/inspect-mp4.md) 与下述电脑端转换、USB 管理、A/B 独立匹配及正式归档工具已提供。手机页面仍在按现场操作语言修订，PWA 尚未验收；真实手机联调、Action 6 MP4 时间含义与分文件特征仍需实测。

工具按个人使用设计，不做云平台、视频监看、转码或大文件 SHA-256。归档工具必须只读原片，不删除、不移动、不修改原片名称；仅向新目录生成副本，同名不覆盖，废片只标记，不确定的匹配留待确认。

## 电脑端模板、USB 备份与视频匹配

Python 3 标准库即可运行模板转换与匹配；真实 USB 串口另需 `pyserial`。支持 CSV（UTF-8 BOM / GB18030）、XLSX 首工作表及 DOCX 表格，中英文表头与重复条目点位合并：

```sh
python3 tools/convert_actions.py 输入.xlsx --template-id CLEANROOM_SMOKE_V1 --template-name 洁净室验证 -o actions.json
python3 tools/usb_manage.py --port COM5 status
python3 tools/usb_manage.py --port COM5 info
python3 tools/usb_manage.py --port COM5 export -o project.jsonl
python3 tools/match_media.py --log project.jsonl --cam-a 原片A --cam-b 原片B --actions actions.json -o match_report.json
```

匹配默认不递归，子目录素材需显式加 `--recursive`。A/B 分别校准相机时钟与创建时间的开始/结束基准，再按共同 `take_id` 汇合；废片参与匹配但不占正式段号，单机保留段正常占号。时间锚点不足、重复候选与损坏文件不会强配；查看报告中的 `pending_confirm`、`missing`、`unclassified`、`corrupt` 及异常证据。相机计时原始值不能未经证据换算就当作秒。

先导出并妥善保管备份，再显式执行以下重置；工具比较本地原始 JSONL 与设备当前项目、事件序号、拍摄编号、行数、LF 字节数，任一变化即拒绝。空备份无法证明项目身份，不用于重置。导出目标必须不存在。

```sh
python3 tools/usb_manage.py --port COM5 reset --backup project.jsonl --confirm
```

可导入 `tools.match_media`：`load_journal(jsonl_path)`、`scan_media(paths_a, paths_b, recursive=False)`、`calibrate_camera_offset(takes, clips, camera_idx)`（0=A，1=B，返回偏移秒或 `None`）、`group_split_parts(clips)`、`match_single_camera(takes, clip_groups, camera_idx, offset_sec)` 与 `match_project(jsonl_path, dir_a, dir_b, actions_path=None, recursive=False)`。完整项目报告保留各机的时间戳假设；自行调用低层分组时须使用对应假设。

目前验证使用合成 MP4 与模拟串口，不等于真实原片时间戳或新 USB 管理工具的硬件验收。

## 电脑端正式归档与核对表

```sh
python3 tools/archive_project.py --log project.jsonl --cam-a 原片A --cam-b 原片B --actions actions.json -o 归档输出 --project-name 车间验证
```

默认不递归，子目录素材加 `--recursive`。输出项目目录名追加 `_层流烟雾流型验证`；不指定项目名称时使用模板名称与项目编号。内容分为：

- 每项拍摄内容的独立目录：正式文件按该项的保留段从 `第01段` 编号；单机素材仍占段号，分文件追加 `_part01`、`_part02`。
- `_废片备查/`：保存已标记不用的片段，使用原 `take_id` 标识，不占正式段号。
- `_待确认/`：保留歧义、无可靠时间证据、外部录像及损坏素材，不能将“已复制”当作“匹配正确”。
- `_台账/`：原始日志、动作清单、`归档映射.json` 与 `拍摄归档与核对总表.xlsx`；核对表包含“拍摄汇总”“文件映射”“异常与修订”三个工作表，可用 Excel/WPS 打开，不需要额外 Python 库。

原片始终只读，以 `copy2` 复制。重跑时跳过大小一致、容器可读且归属相符的已处理副本；同名冲突保留旧文件，使用 `_v2` 等新名称并记入异常。修改片段用途或拍摄内容后重跑会重新编号，保留旧副本与 `归档映射.v1.json` 等历史映射，不会静默覆盖其他片段。

复制验证仅检查精确字节数与 MP4 容器元数据，不是全文无损或可解码证明。命令输出 JSON 报告；存在匹配/复制异常或未验证文件时返回 1，仍应查看已生成的核对表，不要仅凭退出码删除原片或归档。备份日志与素材目录不得被输出目录覆盖。

主机合成素材/模拟串口的 16 项行为测试已通过：

```sh
python3 -m unittest discover -s tests -p test_archive_pipeline.py
```

覆盖三种模板输入、安全 USB 备份与重置、双机独立时钟、废片与单机段编号、分文件、待确认/损坏素材、重复归档、历史映射、同名冲突和 XLSX 内容；这不代表真实相机素材或手机联调已通过。
