# CORE-ESP32-C3 双机无屏幕遥控器

目标：合宙 CORE-ESP32-C3 **经典款**，USB 接口经 CH343P 连接 UART0，外置 4 MB Flash、DIO 模式、160 MHz。复用 DJI-Remote 的 BLE、协议、状态和控制层，仅对外开放相机槽 1、2；第三个内部槽保留以兼容上游数组。

硬件定义来自 [合宙官方板卡文档](https://wiki.luatos.com/chips/esp32c3/board.html)：BOOT 为 GPIO9（低有效），D4 为 GPIO12、D5 为 GPIO13（均高有效）。GPIO12/13 可作 LED 的前提是本板外置 Flash 并采用 **DIO**；不要拿此配置直接烧其他 C3 开发板。经典款使用 UART0 控制台，而非 USB Serial/JTAG。CH343P 驱动应在 macOS 系统设置中允许并启用。

## 使用

短按并松开 **BOOT**：两台都在线、正常视频模式、未休眠，且均有最近 3 秒内的真实相机状态时，开始双机录像。任一台已知在录像时，优先向在线且未休眠的槽发送停止。状态不齐时不会开始录像。显式 `stop` 也会向在线、状态未知的槽尽力发送停止。

按键消抖 30 ms，松开才触发。开机时已按住的 BOOT 不触发录像；必须先松开。上电或复位时按住 BOOT 会进入 ROM 下载模式，因此日常使用先松开再复位。RST 始终仅作复位，不用于录像。

两台收到**新状态回传**且状态符合请求后，串口才显示 `CONFIRMED`。发送命令本身不代表成功。部分停止显示 `PARTIAL STOP`，断连显示 `LINK LOST`，6 秒内没有确认显示 `CONFIRMATION TIMEOUT`。在等待确认时，重复按键不会再次发出命令。异常不会自动撤销已开始的单台录像；使用 `status` 检查，再用 `stop` 停止。

失联后自动逐槽重试，包括遥控器先开机、相机稍后开机的情况。两次尝试至少间隔 5 秒；一次扫描、连接和认证可能耗时几十秒。重连工作在独立任务上进行，主循环仍处理按键、控制台和反馈。恢复连接后不会自动开始或续录。

D4 对应相机 1，D5 对应相机 2：

| 灯态 | 含义 |
|---|---|
| 熄灭 | 该槽尚未配对 |
| 慢闪，约每 0.5 秒切换 | 已配对，正在等待连接 |
| 每秒两次短闪 | 已连接，等待有效状态或状态超时 |
| 常亮 | 有新鲜状态，未录像且未休眠（是否视频模式请用 status 查看） |
| 快闪，约每 0.125 秒切换 | 相机回传正在录像 |
| 每 2 秒短亮一次 | 相机休眠 |
| 两灯更快闪 3 秒 | 请求被拒绝、部分完成、失联或确认超时 |

LED 是状态反馈，不是命令已发送的成功指示。

## 首次配对

使用 115200、8N1 串口终端。相机开机；关闭 Mimo 与其他遥控器的相机连接，以免占用 BLE 通道。

```text
help
scan
list
pair 1 1
status
scan
list
pair 2 2
status
```

`scan` 扫描 10 秒；`list` 中的索引从 1 开始。`pair <槽1或2> <list中的索引>` 明确选择相机，不会自动挑附近的设备。相机屏幕出现连接确认时，需在相机上同意。两槽不能重复配同一 MAC；已占用槽拒绝被直接覆盖。连接工作忙时需等待其结束再配对。

配对成功后保存 MAC、名称、机型标识；遥控器 ID 在首次启动随机生成并持久化，本机蓝牙 MAC 用作协议身份。连接使用 DJI 官方定义的历史感知模式 `verify_mode=0`：相机有记录时直接连接，无记录时要求屏幕确认，避免中断首次确认后反复强制配对。无本地记录时等待确认最多 60 秒，已有记录时最多 30 秒；直接连接请求和晚到 ACK 均保留正确序号，晚 ACK 不重置总等待期限。协议依据见 [DJI 官方连接流程](https://github.com/dji-sdk/Osmo-GPS-Controller-Demo/blob/main/docs/protocol_data_segment.md#connection-request-0019)。

NVS 读取或版本异常不会触发自动全片擦除。两台都设置到普通视频模式，查看 `status` 确认后，即可短按 BOOT 使用。`debug` 可开启 BLE／协议诊断，`quiet` 恢复正常日志；通常不需要开启诊断。

其他命令：

```text
start
stop
toggle
status
```

`start` 不会把已录像的相机反向停止，`stop` 不会把已停止的相机反向开始。重启后直接重连已保存相机，不需每次 `scan/pair`。首版不提供清除配对、换槽、唤醒、GPS 或分辨率设置命令。

## 构建与烧录

使用 ESP-IDF **5.5.x**（CI 配置为 5.5.2）。先按乐鑫官方步骤安装 ESP32-C3 工具链并加载 `export.sh`，然后：

```sh
tools/headless/build.sh
```

脚本使用独立的 `build-c3`、`sdkconfig.c3` 和 `build-c3/dependencies.lock`，不覆盖上游 GUI 的配置与锁文件。C3 编译排除所有屏幕、LVGL、GPS 和 WS2812 驱动。普通 GPIO LED 不需要 led_strip 依赖。

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

使用 C11、严格编译警告和 ASan/UBSan，覆盖双机开始、忙状态拒绝、旧状态不能确认、确认成功、失联的部分停止、陈旧状态/休眠/非视频拒绝开始、确认超时、命令中失联、时钟回绕和 BOOT 消抖。该测试不模拟完整 DJI 蓝牙协议或物理无线链路。

2026-11-09 已在 macOS 上使用官方 ESP-IDF 5.5.2 与 RISC-V GCC 14.2.0 完成应用、引导程序和分区表的实际构建；当前应用固件为 547792 字节。esptool 验证了 ESP32-C3 芯片标识、4 MB／DIO／40 MHz 参数及有效校验和与哈希。此构建最低芯片修订版本为 v0.3；实测连接板为 ESP32-C3 v0.4、4 MB Flash。主机控制策略、真实状态回调及 9 个真实握手场景通过 ASan/UBSan，Shell 语法和 diff 检查通过；控制策略与状态模块的 Clang 静态分析无诊断。

实机已完成：原有全部 4 MB Flash 备份及 SHA-256 记录、刷写及芯片侧哈希校验；两台 Action 6 首次确认并保存；双机串口开始／停止录像；ESP32 重启后两台无需确认自动重连、保持未录像；用户短按实体 BOOT 后两台开始录像，串口停止后两台新状态确认；用户随后再次用 BOOT 开始并结束录像，板端也收到两台状态确认。最终状态为两台在线且未录像。扫描结果也已过滤非 DJI 设备的纯名称响应。

原固件保存在本机 `backups/core-esp32c3-before-dji-remote-20261109.bin`，该目录已加入 git 忽略列表，固件分发包不包含备份、NVS 或私有串口日志。

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

当前发布基线仅包含已实现的无屏幕双机控制。后续计划是关闭 Wi-Fi，以手机作为第三路 BLE 连接选择动作，由 ESP32 保存拍摄日志，再经 USB 导出给电脑，匹配原片并复制归档、命名和生成台账。三路 BLE 和真实 MP4 时间／分文件特征应先实测，不将计划当作已实现能力。

工具按个人使用设计，不做云平台、视频监看、转码或大文件 SHA-256。归档工具必须只读原片，不删除、不移动、不修改原片名称；仅向新目录生成副本，同名不覆盖，废片只标记，不确定的匹配留待确认。
