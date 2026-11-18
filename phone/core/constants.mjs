// Pure constants, icons, and message dictionaries for the Dual-Camera Field Controller UI.

export const TEMPLATE_CACHE_KEY = 'dji-template-current';
export const THEME_CACHE_KEY = 'dji-ui-theme';
export const SOUND_CACHE_KEY = 'dji-ui-sound';
export const STALE_STATUS_MS = 3500;
export const POINT_NAME_MAX_LENGTH = 64;

// Offline H.264 Baseline video: one black 16×16 frame, 1 second, no audio.
export const SCREEN_KEEPALIVE_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMObW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABQwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAKGAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM+AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACjm1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAADmWIhAV///8PRQABQt+A';

export const DEFAULT_TEMPLATE = Object.freeze({
  schema_version: 1,
  template_id: 'CLEANROOM_SMOKE_V1',
  template_name: '洁净室层流烟雾气流流型验证示例',
  actions: Object.freeze([
    Object.freeze({
      action_id: 'S01',
      name: '静态气流流型检查',
      type: 'static',
      group: '分装区',
      order: 1,
      points: Object.freeze([]),
    }),
    Object.freeze({
      action_id: 'D27',
      name: '人员操作期间气流流型检查',
      type: 'dynamic',
      group: '灌装线',
      order: 2,
      points: Object.freeze([
        Object.freeze({ point_id: 'P01', name: '操作口' }),
        Object.freeze({ point_id: 'P02', name: '物料传递口' }),
      ]),
    }),
  ]),
});

export const LED_LABELS = Object.freeze({
  0: '熄灭（未连接）',
  1: '常亮（可以拍摄）',
  2: '慢闪（正在录像）',
  3: '快闪（请检查）',
});

export const TARGET_CAMERA_LABELS = Object.freeze({
  1: '只拍 A 机',
  2: '只拍 B 机',
  3: '双机同拍',
});

export const PRESET_PROJECT_PREFIX = Object.freeze({
  GMP_SMOKE_AREA1_2026R1: 'AREA1',
  GMP_SMOKE_AREA2_2026R1: 'AREA2',
  GMP_SMOKE_AREA3_2026R1: 'AREA3',
  GMP_SMOKE_POST_UF_2026R1: 'POST_UF',
  GMP_SMOKE_GLOB_UF_2026R1: 'GLOB_UF',
  GMP_SMOKE_THAW_2026R1: 'THAW',
  GMP_SMOKE_CD_2026R1: 'CD',
});

export const AUDIO_CUE_PATTERNS = Object.freeze({
  started: Object.freeze([880, 1320]),
  stopped: Object.freeze([660, 440]),
  warning: Object.freeze([330, 330, 330]),
});

export const CAPTURE_FEEDBACK_CODES = new Set(['START', 'START_ACK', 'START_CANCELLED', 'STOP', 'STOP_WAIT', 'STOP_OK']);

export const ERROR_REASONS = Object.freeze({
  disconnected: '连接已断开，请重新连接遥控器。',
  not_connected: '请先连接遥控器。',
  timeout: '没有收到确认，请先更新拍摄记录，不要重复点击。',
  recording_active: '请先停止录像，再修改拍摄项或相机选择。',
  usb_only: '这个操作需要连接电脑完成。',
  storage_full: '遥控器空间不足，请先在电脑上备份。',
  start_rejected_or_storage_full: '所选相机未就绪、其他相机正在录像，或遥控器空间不足。',
  no_action_selected: '请先选择拍摄项。',
  target_mismatch: '所选相机设置与遥控器不一致，请重试。',
  unsupported_firmware: '当前遥控器固件暂不支持相机选择，请先升级遥控器固件。',
  invalid_select_ack: '遥控器返回动作与所选项目不一致，已保持原设置。',
  project_uninitialized: '请先新建拍摄项目。',
  project_not_empty: '已有项目不能在手机上清空，请先在电脑上备份。',
  take_not_ended: '这段还在拍摄中，请先停止录像。',
  take_not_found: '找不到这段拍摄记录，请先更新记录。',
  write_failed: '写入遥控器失败，请重试。',
  busy: '遥控器正忙，请稍后再试。',
  invalid_template: '拍摄清单文件格式不正确。',
  cached_event_conflict: '手机本地记录与遥控器不一致，已暂停覆盖，请检查项目编号。',
  invalid_cached_ledger_json: '手机本地记录损坏，无法读取。请保留当前缓存不要清除，连接电脑后再导出核对。',
  invalid_cached_ledger_identity: '手机本地记录身份信息异常，请保留当前缓存不要清除，连接电脑后再核对。',
  invalid_local_cursor: '手机本地记录位置异常，请保留当前缓存不要清除。',
  QuotaExceededError: '手机浏览器存储空间不足，无法继续写入本机副本。',
  SecurityError: '手机浏览器拒绝访问本地存储（例如无痕模式或存储受限）。',
});

// Monochrome Inline SVG Icons (Stroke 1.75, aria-hidden="true")
export const ICONS = Object.freeze({
  bluetooth: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"></polyline></svg>`,
  sync: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`,
  upload: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  camera: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  step: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 8 16 12 12 16"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg>`,
  prev: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
  next: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  search: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  list: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`,
  history: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  settings: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  record: `<svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle></svg>`,
  stop: `<svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`,
  copy: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  share: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`,
  download: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  theme: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`,
  alert: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
  info: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  checkCircle: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="9 12 11.5 14.5 15.5 9.5"></polyline></svg>`,
  chevronDown: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
});
