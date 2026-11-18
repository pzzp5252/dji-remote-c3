import { BUILTIN_PRESETS } from '../presets/index.mjs';
import { ICONS } from './constants.mjs';
import { formatHumanAreaName } from './formatters.mjs';

export function getAppShellMarkup() {
  return `
    <header id="status-banner-wrap" class="status-banner-wrap">
      <div id="status-banner" class="status-banner" role="status" aria-live="polite" data-tone="idle" data-error-code="">
        <div class="status-banner-main">
          ${ICONS.alert}
          <span id="status-banner-text" class="status-banner-text">请先连接遥控器</span>
        </div>
        <details id="status-banner-details" class="banner-details" hidden>
          <summary>查看详情</summary>
          <code id="status-banner-code" class="status-banner-code"></code>
          <span id="status-banner-detail"></span>
        </details>
      </div>
      <button id="btn-dismiss-feedback" type="button" class="btn" aria-label="关闭提示">关闭</button>
    </header>
    <main class="bento-grid workbench-shell" data-bento-grid="true">
      <section id="topbar-summary" class="topbar-summary bento-span-2" aria-label="遥控器与项目概览">
        <div class="topbar-summary-left">
          <span id="conn-badge" class="badge" data-state="disconnected">
            <span class="badge-dot"></span><span id="conn-badge-text">未连</span>
          </span>
          <span id="topbar-project-summary" class="topbar-meta-text">未创建项目</span>
        </div>
        <div class="topbar-summary-actions">
          <button id="btn-screen-awake" type="button" class="btn btn-awake-pill" aria-label="保持屏幕常亮状态"><span id="screen-awake-notice" role="status">未启用</span></button>
          <button id="btn-toggle-settings" type="button" class="btn" aria-haspopup="dialog" aria-expanded="false">${ICONS.settings}<span id="btn-toggle-settings-label">设备</span></button>
          <button id="btn-theme-toggle" type="button" class="btn btn-icon-only" aria-label="切换明暗主题">${ICONS.theme}</button>
        </div>
        <div id="global-record-host">
          <div id="global-record-strip" class="global-record-strip" hidden>
            <span id="global-record-text"></span>
            <button id="btn-global-stop" type="button" class="btn btn-danger">停止录像</button>
          </div>
        </div>
        <p id="mock-notice" class="mock-notice" hidden>演示模式 · 不会连接真实设备</p>
        <div id="ledger-storage-details" hidden><p id="ledger-storage-notice" role="status"></p><button id="btn-ledger-details" type="button" class="btn">详情</button></div>
      </section>
      <div class="workbench-columns">
        <div id="view-list" class="view-panel" data-view-panel="list" hidden>
          <section id="card-action-search" class="bento-card bento-span-2" aria-labelledby="title-action-search">
            <h2 id="title-action-search" class="visually-hidden">拍摄进度看板</h2>
            <div id="list-progress-dashboard" class="list-progress-dashboard">
              <div class="list-progress-head">
                <span id="list-area-progress-title" class="list-progress-title">当前区域</span>
                <div class="list-progress-right">
                  <span id="list-progress-status" class="badge" hidden></span>
                  <span id="action-count-badge" class="mono-meta">0 项</span>
                </div>
              </div>
              <div class="progress-meter-track" aria-hidden="true">
                <div id="list-progress-fill-ok" class="progress-meter-ok" style="width: 0%"></div>
                <div id="list-progress-fill-warn" class="progress-meter-warn" style="width: 0%"></div>
              </div>
              <div class="list-kpi-grid" aria-label="区域完成度概览">
                <div id="kpi-board-done" class="list-kpi-card" data-tone="ready">已完成 0 / 0 (0%)</div>
                <div id="kpi-board-pending" class="list-kpi-card" data-tone="neutral">待拍 0 项</div>
                <div id="kpi-board-abnormal" class="list-kpi-card" data-tone="neutral">异常 0 项</div>
              </div>
            </div>
            <div class="list-search-room-row">
              <div class="search-box-wrap">${ICONS.search}<input id="input-action-search" type="search" class="input-field search-input" placeholder="搜序号、关键字或层流罩号" aria-label="搜序号、关键字或层流罩号" /></div>
              <details id="action-region-filter" class="action-region-filter">
                <summary id="action-region-filter-summary">房间：全部 ▾</summary>
                <div id="filter-group-pills" class="pill-strip room-popover-list" role="group" aria-label="按房间或层流罩筛选"></div>
              </details>
            </div>
            <div class="list-dimension-row">
              <div id="filter-type-pills" class="segmented-track" role="group" aria-label="按测试阶段筛选"></div>
              <div id="filter-status-pills" class="status-chip-strip" role="group" aria-label="按拍摄状态筛选"></div>
            </div>
            <div id="action-list" class="action-list" role="list"></div>
          </section>
        </div>
        <div id="view-shoot" class="view-panel" data-view-panel="shoot">
          <section id="shoot-stage-connect" class="wizard-stage-card" aria-labelledby="title-stage-connect" hidden>
            <div class="wizard-hero-header">
              ${ICONS.bluetooth}
              <div>
                <h2 id="title-stage-connect" class="wizard-title">连接双机录像遥控器</h2>
                <p class="card-subtitle">开启遥控器电源并靠近手机，点击下方按钮通过蓝牙连接。</p>
              </div>
            </div>
            <button id="btn-reconnect-controller" type="button" class="btn btn-primary wizard-primary-btn">${ICONS.bluetooth}<span id="btn-reconnect-label">连接双机录像遥控器</span></button>
            <p class="card-subtitle wizard-tip">iPhone 请使用 Bluefy 浏览器访问本地加密网址；如需听到状态提示音，请保持机身未静音并调大媒体音量。</p>
            <div id="s1-local-replica-box" class="wizard-subcard">
              <p id="s1-local-replica-note" class="card-subtitle">正在读取本机拍摄记录状态…</p>
              <button id="btn-s1-open-records" type="button" class="btn" hidden>查看本机已存记录</button>
            </div>
          </section>
          <section id="shoot-stage-init" class="wizard-stage-card" aria-labelledby="title-stage-init" hidden>
            <div class="wizard-hero-header">
              <div>
                <h2 id="title-stage-init" class="wizard-title">选择本次确认区域</h2>
                <p class="card-subtitle">已连接遥控器。点选洁净区域后可直接建项，无需手输编号。</p>
              </div>
            </div>
            <div class="wizard-section">
              <div id="init-preset-grid" class="init-preset-grid" role="group" aria-label="六大洁净区确认清单预设">
                ${BUILTIN_PRESETS.map(p => {
                  const stCount = p.actions.filter(a => a.type === 'static').length;
                  const dyCount = p.actions.filter(a => a.type === 'dynamic').length;
                  const areaTitle = p.area_name || formatHumanAreaName(null, p);
                  return `
                <button type="button" class="btn preset-tile-btn" data-preset-id="${p.template_id}" aria-pressed="false">
                  <span class="preset-tile-name">${areaTitle}</span>
                  <span class="preset-tile-count">${p.actions.length} 项 · 静${stCount} 动${dyCount}</span>
                </button>`;
                }).join('')}
              </div>
            </div>
            <div class="wizard-section">
              <label class="field-label" for="input-init-project-id">
                <span>归档项目号（点选区域已自动生成，可按需修改）</span>
                <input id="input-init-project-id" type="text" class="input-field" maxlength="63" placeholder="例如 AREA2_20261117" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
              </label>
              <details id="init-advanced-fold" class="init-advanced-fold">
                <summary>高级：从文件导入清单 JSON / 清单代号</summary>
                <div class="init-advanced-body">
                  <button id="btn-init-import-json" type="button" class="btn">${ICONS.upload}<span>从文件导入清单 JSON</span></button>
                  <label class="field-label" for="input-init-template-id">
                    <span>内部清单代号（供电脑归档核对）</span>
                    <input id="input-init-template-id" type="text" class="input-field" maxlength="63" placeholder="已选拍摄清单编号" autocapitalize="off" autocorrect="off" spellcheck="false" />
                  </label>
                </div>
              </details>
              <button id="btn-init-project" type="button" class="btn btn-primary wizard-primary-btn">创建项目并进入</button>
            </div>
          </section>
          <section id="shoot-stage-mismatch" class="wizard-stage-card" aria-labelledby="title-stage-mismatch" hidden>
            <div class="wizard-hero-header">
              <div>
                <h2 id="title-stage-mismatch" class="wizard-title">清单与遥控器项目不匹配</h2>
                <p id="mismatch-device-summary" class="card-subtitle"></p>
              </div>
            </div>
            <div class="wizard-section">
              <button id="btn-load-builtin-matching-template" type="button" class="btn btn-primary wizard-primary-btn" hidden></button>
              <button id="btn-import-matching-template" type="button" class="btn btn-primary">${ICONS.upload}<span>导入与设备一致的清单文件</span></button>
            </div>
            <div id="mismatch-usb-notice" class="notice-box" data-tone="warn">
              <strong id="mismatch-readonly-title">如需改用另一套清单或开新项目</strong>
              <p id="mismatch-readonly-desc" class="card-subtitle"></p>
            </div>
          </section>
          <section id="shoot-stage-ready" class="shoot-ready-stage" aria-label="现场拍摄工作台">
            <div id="shoot-z3-slot" class="shoot-z3-slot" data-tone="warn" hidden>
              <div class="shoot-z3-body">
                <span id="record-observation-text" class="shoot-z3-text">请先连接遥控器</span>
              </div>
              <div id="record-recovery-actions" class="record-recovery-actions" hidden>
                <button id="btn-dock-reconnect" type="button" class="btn btn-primary" hidden>重新连接遥控器</button>
              </div>
            </div>
            <div id="shoot-middle-scroll" class="shoot-middle-scroll">
              <div id="demo-template-warning" class="demo-warning-bar" role="status" hidden>当前使用的是示例/验收清单，仅作演示或测试，切勿用于正式洁净室拍摄</div>
              <section id="card-current-action" class="bento-card bento-span-2 bento-card-primary" aria-labelledby="title-current-action">
                <div class="card-header">
                  <div class="card-title-group">${ICONS.step}<h2 id="title-current-action" class="card-title visually-hidden">当前拍摄项</h2></div>
                  <div class="card-header-actions">
                    <span id="action-pending-badge" class="badge" data-state="warn" hidden>正在切换拍摄项，请稍候</span>
                  </div>
                </div>
                <div id="confirmed-action-hero" class="current-action-hero">
                  <div class="hero-top-grid">
                    <div class="hero-main-col">
                      <div class="current-action-badges">
                        <span id="confirmed-action-id" class="current-action-code">未选择</span>
                        <span id="current-action-progress-badge" class="badge" hidden>○ 未拍</span>
                      </div>
                      <p id="confirmed-action-group-line" class="current-action-group" hidden></p>
                      <h3 id="confirmed-action-name" class="current-action-name">请从看板选择一项</h3>
                    </div>
                    <div class="current-action-utils">
                      <button id="btn-rename-point" type="button" class="btn btn-rename-point" hidden>补名</button>
                      <button id="btn-trigger-add-point" type="button" class="btn-add-point" aria-label="现场新增点位">+ 点位</button>
                      <button id="btn-current-details" type="button" class="btn btn-ghost-util" aria-haspopup="dialog">详情</button>
                    </div>
                  </div>
                  <p id="confirmed-action-desc" class="current-action-desc" hidden></p>
                  <p id="confirmed-action-custom-criteria" class="current-action-custom-criteria" hidden></p>
                </div>
                <button id="unselected-action-cta" type="button" class="btn btn-primary unselected-action-cta" hidden>选用第 1 项开始</button>
                <div id="points-container" hidden>
                  <button id="btn-open-point-sheet" type="button" class="btn point-drawer-trigger" aria-haspopup="dialog">
                    <span class="point-drawer-label">当前点位</span>
                    <span id="confirmed-point-id" class="point-drawer-value">不指定拍摄位置</span>
                    <span id="point-drawer-count" class="badge"></span>
                  </button>
                </div>
              </section>
              <div class="shoot-mid-columns">
                <section id="shoot-action-takes-section" class="shoot-section shoot-takes-section" aria-labelledby="shoot-takes-heading" hidden>
                  <div class="shoot-section-head">
                    <div class="shoot-section-head-left">
                      <h3 id="shoot-takes-heading" class="shoot-section-title">本项已拍记录</h3>
                      <span id="shoot-takes-subtitle" class="shoot-section-sub"></span>
                    </div>
                    <div id="shoot-takes-point-filter" class="shoot-point-filter" hidden>
                      <button id="btn-takes-filter-all" type="button" class="btn btn-chip is-active" data-takes-filter="all" aria-pressed="true">全部</button>
                      <button id="btn-takes-filter-point" type="button" class="btn btn-chip" data-takes-filter="current_point" aria-pressed="false">当前点位</button>
                    </div>
                  </div>
                  <p id="shoot-takes-sync-note" class="shoot-takes-sync-note" hidden></p>
                  <div id="shoot-action-takes-list" class="shoot-takes-list" role="list"></div>
                  <button id="btn-shoot-takes-expand" type="button" class="btn shoot-expand-btn" hidden>看全部 ▾</button>
                </section>
                <section id="shoot-group-queue-section" class="shoot-section shoot-queue-section" aria-labelledby="shoot-queue-heading">
                  <div class="shoot-section-head">
                    <div class="shoot-section-head-left">
                      <h3 id="shoot-queue-heading" class="shoot-section-title">本组队列</h3>
                      <span id="shoot-queue-stats" class="shoot-section-sub"></span>
                    </div>
                    <button id="btn-open-action-list" type="button" class="btn shoot-jumper-btn" aria-haspopup="dialog">全部 0 ▾</button>
                  </div>
                  <div id="shoot-group-queue-list" class="shoot-queue-list" role="list"></div>
                  <details id="shoot-group-completed-fold" class="group-fold" hidden>
                    <summary id="shoot-group-completed-summary">✓ 本组已完成 0 项</summary>
                    <div id="shoot-group-completed-list" class="shoot-queue-list shoot-queue-completed-list"></div>
                  </details>
                  <details id="shoot-related-groups-fold" class="group-fold" hidden>
                    <summary id="shoot-related-groups-summary">同编码关联分组另有 0 项</summary>
                    <div id="shoot-related-groups-list" class="shoot-queue-list"></div>
                  </details>
                  <button id="btn-next-group-preview" type="button" class="btn btn-next-group-preview" hidden></button>
                  <details id="shoot-criteria-source-fold" class="group-fold" hidden>
                    <summary>标准与文件来源（按需展开）</summary>
                    <div id="shoot-criteria-source-body" class="group-fold-body">
                      <p id="shoot-default-criteria-text" class="card-subtitle"></p>
                      <p id="shoot-source-doc-text" class="card-subtitle"></p>
                    </div>
                  </details>
                </section>
              </div>
            </div>
            <div id="shoot-scroll-area" class="shoot-control-deck">
              <div id="shoot-record-controls">
                <div id="shoot-camera-status" class="camera-dock-section">
                  <div class="card-header">
                    <div class="card-title-group">${ICONS.record}<h2 id="title-record-ledger" class="card-title">录像与相机控制</h2></div>
                    <span id="phase-badge" class="badge" data-state="disconnected">状态：待机</span>
                  </div>
                  <div class="camera-pair-grid">
                    ${['a', 'b'].map((camera, index) => {
                      const camLetter = index === 0 ? 'A' : 'B';
                      const slotBit = index === 0 ? 1 : 2;
                      return `
                    <section id="card-cam-${camera}" class="cam-dock-card is-disconnected" aria-label="相机 ${camLetter}">
                      <button id="btn-cam-toggle-${camera}" type="button" class="cam-dock-main" data-cam-slot="${slotBit}" aria-pressed="true">
                        <div class="cam-dock-row1">
                          ${ICONS.checkCircle}
                          <span id="title-cam-${camera}" class="cam-dock-title">${camLetter} 机</span>
                        </div>
                        <div id="cam-${camera}-badge" class="cam-dock-row2" data-state="disconnected">
                          <span id="cam-${camera}-badge-text" class="cam-dock-status">未连接</span>
                        </div>
                        <div id="cam-${camera}-metrics" class="cam-dock-row3">
                          <span id="cam-${camera}-battery" class="cam-metric-val"></span>
                          <span id="cam-${camera}-fresh" class="cam-metric-fresh"></span>
                        </div>
                      </button>
                      <button id="btn-cam-diag-${camera}" type="button" class="cam-dock-diag" data-cam-diag="${camera}" aria-label="打开相机 ${camLetter} 诊断" aria-haspopup="dialog">
                        ${ICONS.info}
                      </button>
                    </section>`;
                    }).join('')}
                  </div>
                </div>
                <button id="btn-record-main" type="button" class="btn btn-ready record-cta-btn" data-mode="start">
                  <span class="record-btn-primary-row">
                    <span id="btn-record-icon">${ICONS.record}</span>
                    <span id="btn-record-label">开始录像</span>
                    <span id="record-elapsed" class="record-btn-elapsed" aria-label="本条计时" hidden>待确认</span>
                  </span>
                  <span id="btn-record-meta" class="record-btn-meta" hidden></span>
                </button>
              </div>
            </div>
          </section>
        </div>
        <div id="view-records" class="view-panel" data-view-panel="records" hidden>
          <section id="card-records-history" class="bento-card bento-span-2" aria-labelledby="title-records-history">
            <div class="records-header">
              <div class="records-header-left">
                <div class="card-title-group">${ICONS.history}<h2 id="title-records-history" class="card-title">已拍记录</h2></div>
                <span id="takes-count-badge" class="badge">有效 0 / 共 0 条</span>
              </div>
              <div class="records-header-actions">
                <button id="btn-records-sync" type="button" class="btn" disabled>${ICONS.sync}<span>同步</span></button>
                <details id="records-export-menu" class="records-export-menu">
                  <summary id="btn-records-export-summary">导出 ▾</summary>
                  <div class="records-export-popover">
                    <p class="card-subtitle">导出仅含拍摄台账，不含相机原片。</p>
                    <p class="card-subtitle backup-clip-note">归档序号按导出当时的有效/废片与修改拍摄项状态计算，后续修改可能导致重排；A/B 观察段次含废片，请回电脑核对。</p>
                    <div class="records-export-buttons">
                      <button id="btn-backup-copy" type="button" class="btn btn-muted-outline">${ICONS.copy}<span>复制备份</span></button>
                      <button id="btn-backup-share" type="button" class="btn btn-muted-outline">${ICONS.share}<span>分享备份</span></button>
                      <button id="btn-backup-download" type="button" class="btn btn-muted-outline">${ICONS.download}<span>保存 JSON 备份</span></button>
                      <button id="btn-backup-csv" type="button" class="btn btn-muted-outline">${ICONS.download}<span>导出 CSV 表格</span></button>
                    </div>
                  </div>
                </details>
              </div>
            </div>
            <div id="records-handoff-summary" class="records-handoff-summary"></div>
            <div class="records-toolbar">
              <div id="records-filter-pills" class="status-chip-strip" role="group" aria-label="按记录状态筛选"></div>
              <div class="records-select-actions">
                <button id="btn-records-select-all" type="button" class="btn btn-chip">全选</button>
                <button id="btn-records-clear-selection" type="button" class="btn btn-chip">清空</button>
              </div>
            </div>
            <div class="records-subhint-bar">
              <span id="records-clip-incomplete-note" class="badge records-incomplete-pill" data-state="warn" hidden>副本待更新，序号仅供参考</span>
              <p class="records-helper-hint">点左侧多选勾选 · 点行尾 [▾] 查看 A/B 机明细</p>
              <span id="records-sync-status" class="records-sync-status" role="status"></span>
            </div>
            <div id="recent-takes-list" class="takes-list" role="list"></div>
          </section>
          <div id="records-batch-bar" class="records-batch-bar" aria-label="批量操作栏">
            <div class="records-batch-summary">
              <span id="records-batch-count" class="records-batch-count">未选记录</span>
              <span id="records-batch-ids" class="records-batch-ids" hidden></span>
            </div>
            <div class="records-batch-actions">
              <button id="btn-batch-discard-toggle" type="button" class="btn" disabled>请先勾选记录</button>
              <button id="btn-batch-reassign" type="button" class="btn btn-primary" disabled>修改拍摄项</button>
            </div>
          </div>
        </div>
      </div>
      <nav id="bottom-view-nav" class="bottom-view-nav" aria-label="工作台视图切换">
        <button id="nav-btn-list" type="button" class="view-nav-btn" data-view-nav="list" aria-pressed="false">${ICONS.list}<span id="nav-list-label">看板</span></button>
        <button id="nav-btn-shoot" type="button" class="view-nav-btn is-active" data-view-nav="shoot" aria-pressed="true">${ICONS.record}<span>现场</span></button>
        <button id="nav-btn-records" type="button" class="view-nav-btn" data-view-nav="records" aria-pressed="false">${ICONS.history}<span id="nav-records-label">记录</span><span id="records-sync-hint" role="status"></span></button>
      </nav>
      <dialog id="modal-settings" class="ios-bottom-sheet" aria-labelledby="title-connection">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <div class="sheet-header">
          <button id="btn-settings-close" type="button" class="btn" aria-label="关闭设备设置">关闭</button>
        </div>
        <section id="card-connection" class="bento-card bento-span-2" aria-labelledby="title-connection">
          <div class="card-header">
            <div class="card-title-group">
              ${ICONS.bluetooth}
              <div>
                <h2 id="title-connection" class="card-title">设备连接与系统设置</h2>
                <p id="template-subtitle" class="card-subtitle"></p>
              </div>
            </div>
          </div>
          <div class="kv-grid">
            <div class="kv-item"><span class="kv-label">当前项目</span><span id="meta-project-id" class="kv-value">尚未创建</span></div>
            <div class="kv-item"><span class="kv-label">记录条数</span><span id="meta-take-id" class="kv-value">0</span></div>
          </div>
          <div class="button-row">
            <button id="btn-connect" type="button" class="btn btn-primary">${ICONS.bluetooth}<span id="btn-connect-label">连接遥控器</span></button>
            <button id="btn-sync-log" type="button" class="btn" disabled>${ICONS.sync}<span>同步拍摄记录</span></button>
            <button id="btn-import-template" type="button" class="btn">${ICONS.upload}<span>导入拍摄清单</span></button>
          </div>
          <div class="sound-setting-wrap">
            <div class="sound-setting-bar">
              <label class="sound-setting-row" for="input-status-sound">
                <input id="input-status-sound" type="checkbox" checked />
                <span>状态提示音</span>
              </label>
              <button id="btn-test-sound" type="button" class="btn">试听提示音</button>
            </div>
            <p id="sound-mute-hint" class="card-subtitle">提示音受 iPhone 机身静音拨片控制，响铃模式开且调大媒体音量才可听见，不可替代屏幕状态确认。</p>
            <p id="status-sound-note" class="card-subtitle" role="status" hidden></p>
          </div>
          <details id="device-details" class="device-details">
            <summary>设备详情</summary>
            <div class="kv-grid">
              <div class="kv-item"><span class="kv-label">拍摄清单编号</span><span id="meta-template-id" class="kv-value"></span></div>
              <div class="kv-item"><span class="kv-label">设备已保存 / 手机已保存</span><span id="meta-event-seq" class="kv-value">0 / 0</span></div>
              <div class="kv-item"><span class="kv-label">遥控器剩余空间</span><span id="meta-free-bytes" class="kv-value">未知</span></div>
              <div class="kv-item"><span class="kv-label">时间校准与记录保存</span><span id="meta-time-sync" class="kv-value">未连接</span></div>
            </div>
            ${['a', 'b'].map((camera, index) => {
              const camLetter = index === 0 ? 'A' : 'B';
              return `
            <details id="cam-${camera}-details" class="device-details">
              <summary>相机 ${camLetter} 诊断</summary>
              <div class="kv-grid">
                <div class="kv-item"><span class="kv-label">拍摄状态</span><span id="cam-${camera}-mode" class="kv-value">未连接</span></div>
                <div class="kv-item"><span class="kv-label">相机返回的计时数值</span><span id="cam-${camera}-record-time" class="kv-value">0</span></div>
              </div>
              <p class="card-subtitle">计时单位尚未确认，这个数值不作为录像时长。</p>
              <div class="cam-led-box"><span>遥控器指示灯</span><span id="cam-${camera}-led" class="badge"></span></div>
            </details>`;
            }).join('')}
            <div id="usb-reset-notice" class="notice-box" hidden>
              <span>需要清空项目？</span>
              <span class="card-subtitle">请先在电脑上备份，再连接电脑清空遥控器。手机上不能清空项目。</span>
            </div>
          </details>
        </section>
      </dialog>
      <input id="input-template-file" type="file" accept=".json,application/json" aria-label="选择拍摄清单文件" class="visually-hidden" />
      <dialog id="modal-add-point" class="ios-bottom-sheet" aria-labelledby="modal-add-point-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="modal-add-point-title" class="sheet-title">现场新增点位</h3>
        <form id="form-add-point" class="sheet-form" method="dialog">
          <label class="field-label" for="input-add-point-id">
            <span>点位编号（仅限英文字母、数字、下划线或短横线）</span>
            <input id="input-add-point-id" type="text" class="input-field" maxlength="16" placeholder="例如 A1" autocomplete="off" pattern="^[A-Za-z0-9_\\-]+$" inputmode="text" aria-describedby="msg-add-point-error" required />
          </label>
          <label class="field-label" for="input-add-point-name">
            <span>点位名称（可选，如 传递口操作面）</span>
            <input id="input-add-point-name" type="text" class="input-field" maxlength="64" placeholder="未命名点位" autocomplete="off" />
          </label>
          <div id="msg-add-point-error" class="sheet-error-msg" role="alert" aria-live="polite"></div>
          <div class="button-row">
            <button id="btn-cancel-add-point" type="button" class="btn btn-muted-outline">取消</button>
            <button id="btn-confirm-add-point" type="submit" class="btn btn-primary">保存并选中</button>
          </div>
        </form>
      </dialog>
      <dialog id="modal-shoot-details" class="ios-bottom-sheet" aria-labelledby="shoot-details-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="shoot-details-title" class="sheet-title"></h3>
        <dl id="shoot-details-content"><dt>类型</dt><dd id="confirmed-action-type"></dd><dt>位置</dt><dd id="confirmed-action-group"></dd></dl>
        <div id="shoot-orphan-points"></div>
        <button id="btn-shoot-details-close" type="button" class="btn">关闭</button>
      </dialog>
      <dialog id="modal-cam-diag" class="ios-bottom-sheet" aria-labelledby="diag-cam-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="diag-cam-title" class="sheet-title">相机诊断详情</h3>
        <div class="sheet-body-scroll">
          <div class="kv-grid">
            <div class="kv-item"><span class="kv-label">本条参与情况</span><span id="diag-cam-participation" class="kv-value"></span></div>
            <div class="kv-item"><span class="kv-label">拍摄状态</span><span id="diag-cam-mode" class="kv-value"></span></div>
            <div class="kv-item"><span class="kv-label">电池电量</span><span id="diag-cam-battery" class="kv-value"></span></div>
            <div class="kv-item"><span class="kv-label">状态新鲜度</span><span id="diag-cam-fresh" class="kv-value"></span></div>
            <div class="kv-item"><span class="kv-label">相机计时数值</span><span id="diag-cam-record-time" class="kv-value"></span></div>
            <div class="kv-item"><span class="kv-label">遥控器指示灯</span><span id="diag-cam-led" class="badge"></span></div>
          </div>
          <p id="diag-cam-ready-hint" class="card-subtitle"></p>
        </div>
        <button id="btn-cam-diag-close" type="button" class="btn">关闭</button>
      </dialog>
      <dialog id="modal-point-list" class="ios-bottom-sheet" aria-labelledby="point-list-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="point-list-title" class="sheet-title">选择拍摄点位</h3>
        <p id="point-list-subtitle" class="card-subtitle"></p>
        <div class="sheet-body-scroll">
          <div id="point-pills" class="point-sheet-list" role="listbox" aria-label="当前拍摄项可选点位"></div>
        </div>
        <div class="button-row">
          <button id="btn-point-sheet-add" type="button" class="btn">+ 新增点位</button>
          <button id="btn-point-list-close" type="button" class="btn btn-muted-outline">关闭</button>
        </div>
      </dialog>
      <dialog id="modal-action-jumper" class="ios-bottom-sheet" aria-labelledby="action-jumper-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="action-jumper-title" class="sheet-title">全表切换拍摄项</h3>
        <div class="jumper-search-row">
          <div class="search-box-wrap">${ICONS.search}<input id="input-jumper-search" type="search" class="input-field search-input" placeholder="搜序号、名称或房间" aria-label="搜全部拍摄项" /></div>
          <button id="btn-jumper-open-board" type="button" class="btn">去看板筛选</button>
        </div>
        <div id="action-jumper-body" class="sheet-body-scroll">
          <div id="action-jumper-list" class="action-jumper-list" role="listbox" aria-label="全部拍摄项"></div>
        </div>
        <button id="btn-action-jumper-close" type="button" class="btn btn-muted-outline">关闭</button>
      </dialog>
      <dialog id="modal-reassign" class="ios-bottom-sheet" aria-labelledby="reassign-context-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-banner-slot" data-sheet-banner-slot></div>
        <div class="sheet-stop-slot" data-sheet-stop-slot></div>
        <h3 id="reassign-context-title" class="sheet-title">修改拍摄项</h3>
        <p id="reassign-lock-hint" class="sheet-error-msg" role="alert" hidden></p>
        <div class="search-box-wrap">${ICONS.search}<input id="input-reassign-search" type="search" class="input-field search-input" placeholder="搜编号、测试项目或层流罩" aria-label="筛选目标拍摄项" /></div>
        <div id="reassign-sheet-body" class="sheet-body-scroll">
          <div id="reassign-action-list" class="reassign-option-list" role="listbox" aria-label="目标拍摄项"></div>
          <div id="reassign-point-section" class="reassign-point-section" hidden>
            <p class="wizard-section-label">选择目标点位</p>
            <div id="reassign-point-list" class="reassign-option-list" role="listbox" aria-label="目标点位"></div>
          </div>
        </div>
        <p id="reassign-change-preview" class="card-subtitle"></p>
        <div class="button-row">
          <button id="btn-reassign-cancel" type="button" class="btn btn-muted-outline">取消</button>
          <button id="btn-reassign-confirm" type="button" class="btn btn-primary">确认修改</button>
        </div>
      </dialog>
    </main>
  `;
}
