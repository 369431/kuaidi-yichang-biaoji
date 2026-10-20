/* Packing station panel. Vanilla JS, no build step: it is served by the adapter itself. */

const ui = {
  state: null,
  reasons: [],
  selectedReason: "",
  busy: false,
  refreshing: false,
  operatorTouched: false,
  hotkeyEditor: null,
  capture: null
};

const elements = {
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  tracking: document.getElementById("tracking"),
  scanMeta: document.getElementById("scanMeta"),
  scanBanner: document.getElementById("scanBanner"),
  reasons: document.getElementById("reasons"),
  hotkeyHint: document.getElementById("hotkeyHint"),
  editHotkeys: document.getElementById("editHotkeys"),
  hotkeyModal: document.getElementById("hotkeyModal"),
  hotkeyBody: document.getElementById("hotkeyBody"),
  note: document.getElementById("note"),
  operator: document.getElementById("operator"),
  submit: document.getElementById("submit"),
  submitHint: document.getElementById("submitHint"),
  recent: document.getElementById("recent"),
  recentEmpty: document.getElementById("recentEmpty"),
  host: document.getElementById("host"),
  node: document.getElementById("node"),
  accessUrls: document.getElementById("accessUrls"),
  systemStatus: document.getElementById("systemStatus"),
  retryFirewall: document.getElementById("retryFirewall"),
  toggleAutoStart: document.getElementById("toggleAutoStart"),
  toggleOverlay: document.getElementById("toggleOverlay"),
  authBanner: document.getElementById("authBanner"),
  reauth: document.getElementById("reauth"),
  restartPanel: document.getElementById("restartPanel"),
  stopPanel: document.getElementById("stopPanel"),
  dataDir: document.getElementById("dataDir"),
  toast: document.getElementById("toast")
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "attrs") for (const [name, attr] of Object.entries(value)) node.setAttribute(name, attr);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node[key] = value;
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

let toastTimer = null;
function toast(message, kind = "") {
  elements.toast.textContent = message;
  elements.toast.className = `toast is-visible ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.className = "toast";
  }, kind === "error" ? 6000 : 4200);
}

function currentTarget(state) {
  const current = state?.watcher?.current;
  if (current?.trackingNumber) return { ...current, live: true };
  const stopped = state?.watcher?.lastStop;
  if (stopped?.trackingNumber) return { ...stopped, live: false };
  const scan = state?.watcher?.lastScan;
  if (scan?.trackingNumber) return { ...scan, live: false };
  return null;
}

function formatTime(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function relative(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  return formatTime(isoValue);
}

function renderStatus(state) {
  const auth = state?.auth || {};
  const watcher = state?.watcher || {};
  elements.statusPill.className = "status-pill";
  if (auth.status !== "authorized") {
    elements.statusPill.classList.add("is-bad");
    elements.statusText.textContent = auth.status === "enrolling" ? "等待授权确认" : "未授权";
    return;
  }
  if (watcher.status === "error") {
    elements.statusPill.classList.add("is-bad");
    elements.statusText.textContent = "主机连接失败";
    return;
  }
  if (watcher.current) {
    elements.statusPill.classList.add("is-live");
    elements.statusText.textContent = "录像中";
    return;
  }
  elements.statusText.textContent = "等待扫码";
}

function renderTracking(state) {
  const target = currentTarget(state);
  elements.tracking.className = "tracking-value";
  elements.scanBanner.hidden = true;
  elements.scanBanner.className = "banner warn";

  if (!target) {
    elements.tracking.classList.add("is-empty");
    elements.tracking.textContent = "等待扫码…";
    elements.scanMeta.textContent = "在 PackingProof 扫码开始录制后面板会自动跟上";
    return;
  }

  elements.tracking.textContent = target.trackingNumber;
  if (target.live) {
    const mode = target.mode ? ` · ${target.mode}` : "";
    elements.scanMeta.textContent = `录像中${mode} · 开始于 ${formatTime(target.startTime)} · 会话 ${String(target.sessionId || "").slice(0, 8)}`;
    return;
  }

  elements.scanMeta.textContent = `上一单 · 扫描于 ${formatTime(target.stopTime || target.startTime || target.detectedAt)}`;
  elements.scanBanner.hidden = false;
  elements.scanBanner.className = "banner warn";
  elements.scanBanner.textContent = "这段录像已经结束：标记仍会保存，但不能再写进录像水印。";
}

function renderReasons(state) {
  const reasons = Array.isArray(state?.settings?.reasons) ? state.settings.reasons : [];
  const signature = reasons.join("|");
  if (ui.reasonsSignature === signature) return;
  ui.reasonsSignature = signature;
  ui.reasons = reasons;
  elements.reasons.replaceChildren(
    ...reasons.map((reason, index) =>
      el(
        "button",
        {
          class: "reason-button",
          type: "button",
          attrs: { "aria-pressed": String(ui.selectedReason === reason) },
          onclick: () => selectReason(reason)
        },
        el("span", { class: "key", text: String(index + 1) }),
        reason
      )
    )
  );
}

function renderReasonSelection() {
  for (const button of elements.reasons.querySelectorAll("button")) {
    const label = button.lastChild?.textContent || "";
    button.setAttribute("aria-pressed", String(label === ui.selectedReason));
  }
}

function selectReason(reason) {
  ui.selectedReason = ui.selectedReason === reason ? "" : reason;
  renderReasonSelection();
  updateSubmitState();
}

function updateSubmitState() {
  const target = ui.state ? currentTarget(ui.state) : null;
  const authorized = ui.state?.auth?.status === "authorized";
  const ready = Boolean(target && ui.selectedReason && authorized && !ui.busy);
  elements.submit.disabled = !ready;
  if (!authorized) {
    elements.submitHint.textContent = "扩展还没有获得授权，请先点“重新授权”";
  } else if (!target) {
    elements.submitHint.textContent = "先扫码开始录像，再选择异常原因";
  } else if (!ui.selectedReason) {
    elements.submitHint.textContent = "选择上方的异常原因（或按 1-6）";
  } else if (ui.busy) {
    elements.submitHint.textContent = "正在保存…";
  } else {
    elements.submitHint.textContent = `将标记 ${target.trackingNumber} 为“${ui.selectedReason}”`;
  }
}

function renderRecent(state) {
  const records = Array.isArray(state?.recent) ? state.recent : [];
  elements.recentEmpty.hidden = records.length > 0;
  elements.recent.replaceChildren(
    ...records.map((record) =>
      el(
        "li",
        { class: "recent-item" },
        el("span", { class: "code", text: record.trackingNumber }),
        el("span", { text: record.reason || "" }),
        el("span", { class: `tag ${record.voided ? "revoked" : record.status}`, text: record.statusLabel || record.status }),
        el("span", { class: "hint", text: relative(record.createdAt) })
      )
    )
  );
}

function renderAuth(state) {
  const auth = state?.auth || {};
  const healthy = auth.status === "authorized";
  elements.authBanner.hidden = healthy;
  if (!healthy) {
    elements.authBanner.className = "banner error";
    elements.authBanner.textContent =
      auth.message || (auth.status === "enrolling" ? "等待在 PackingProof 电脑端确认授权…" : "尚未获得授权");
  }
  elements.host.textContent = state?.host || "—";
  elements.node.textContent = state?.node?.name ? `${state.node.name}` : "—";
  renderAccess(state);
  elements.dataDir.textContent = state?.dataDirectory || "";
  elements.dataDir.title = state?.dataDirectory || "";
  if (!ui.operatorTouched) {
    elements.operator.value = state?.settings?.operator || "";
  }
}

function renderAccess(state) {
  const access = state?.access || {};
  const urls = Array.isArray(access.urls) ? access.urls : [];
  const lan = urls.filter((value) => !value.includes("127.0.0.1"));
  const parts = [el("span", { text: access.bind === "lan" ? "局域网访问：已开启" : "局域网访问：仅本机" })];
  if (lan.length > 0) {
    parts.push(
      el(
        "span",
        {},
        "手机/其他电脑打开：",
        ...lan.map((value, index) =>
          el(
            "span",
            {},
            index > 0 ? " · " : "",
            el("a", { href: value, text: value.replace(/^http:\/\//, ""), attrs: { target: "_blank", rel: "noreferrer" } })
          )
        )
      )
    );
  }
  if (access.tokenRequired) parts.push(el("span", { text: "需要访问令牌（?token=…）" }));
  elements.accessUrls.replaceChildren(...parts);

  const system = state?.system || {};
  const firewall = system.firewall || {};
  const autoStart = system.autoStart || {};
  const overlay = state?.overlay || {};
  const firewallLabel =
    firewall.state === "ready"
      ? "已放行（手机/其他电脑可访问）"
      : firewall.state === "asking"
        ? "等待管理员确认…"
        : firewall.state === "unsupported"
          ? "不适用"
          : `未放行：${firewall.message || "未知"}`;
  elements.systemStatus.replaceChildren(
    el("span", { text: `防火墙：${firewallLabel}` }),
    el("span", { text: `开机自启：${autoStart.enabled ? "已开启" : "未开启"}` }),
    el("span", { text: `悬浮标记条：${overlay.running ? "已显示" : overlay.enabled ? "未运行" : "已关闭"}` })
  );
  elements.toggleAutoStart.textContent = `开机自启：${autoStart.enabled ? "开" : "关"}`;
  elements.toggleOverlay.textContent = `悬浮标记条：${overlay.running ? "开" : "关"}`;
}

function renderHotkeys(state) {
  const hotkeys = state?.hotkeys || {};
  const hint = elements.hotkeyHint;
  if (!hint) return;
  const reasons = Array.isArray(state?.settings?.reasons) ? state.settings.reasons.length : 6;
  const armSeconds = Number(state?.settings?.hotkeyArmSeconds) || 8;
  if (hotkeys.status === "ready") {
    const failed =
      (hotkeys.bindings || []).filter((binding) => !binding.ok).length +
      (hotkeys.activator && !hotkeys.activator.ok ? 1 : 0) +
      (hotkeys.undo && !hotkeys.undo.ok ? 1 : 0);
    const parts = [];
    if (hotkeys.activator?.keys) {
      parts.push(`按 ${hotkeys.activator.keys} 进入标记模式，再按 1-${reasons} 选原因（${armSeconds} 秒内有效，Esc 取消）`);
    }
    const direct = (hotkeys.bindings || []).map((binding) => `${binding.keys} 直配${binding.reason}`).join(" · ");
    if (direct) parts.push(direct);
    if (hotkeys.undo?.keys) parts.push(`${hotkeys.undo.keys} 撤销`);
    hint.className = hotkeys.armed ? "banner warn" : "banner info";
    hint.textContent = hotkeys.armed
      ? `标记模式已开启：按 1-${reasons} 选择原因，Esc 取消`
      : parts.join(" · ") || "快捷键未配置";
    if (failed > 0) {
      hint.className = "banner warn";
      hint.textContent += `（${failed} 个组合注册失败，可能被别的程序占用，可点「自定义快捷键」换）`;
    }
    return;
  }
  if (hotkeys.status === "unsupported" || state?.settings?.hotkeysEnabled === false) {
    hint.className = "banner warn";
    hint.textContent =
      state?.settings?.hotkeysEnabled === false
        ? "全局快捷键已在 settings.json 中关闭，只能在这个页面点按钮标记"
        : hotkeys.message || "全局快捷键不可用，只能在这个页面点按钮标记";
    return;
  }
  if (hotkeys.status === "error") {
    hint.className = "banner error";
    hint.textContent = `全局快捷键注册失败：${hotkeys.message || "未知原因"}。仍可在本页点按钮标记。`;
    return;
  }
  hint.className = "banner info";
  hint.textContent = "正在注册全局快捷键…（在 PackingProof 里按键即可标记）";
}

function render(state) {
  ui.state = state;
  renderStatus(state);
  renderTracking(state);
  renderReasons(state);
  renderReasonSelection();
  renderHotkeys(state);
  renderRecent(state);
  renderAuth(state);
  updateSubmitState();
}

function bindingFor(settings, reason) {
  const list = Array.isArray(settings?.hotkeyBindings) ? settings.hotkeyBindings : [];
  return list.find((binding) => binding.reason === reason)?.keys || "";
}

function openHotkeyEditor() {
  const settings = ui.state?.settings || {};
  const reasons = Array.isArray(settings.reasons) ? settings.reasons : ui.reasons;
  ui.hotkeyEditor = {
    activator: settings.hotkeyActivator || "F9",
    armSeconds: Number(settings.hotkeyArmSeconds) || 8,
    undo: settings.hotkeyUndo || "",
    rows: reasons.map((reason) => ({ reason, keys: bindingFor(settings, reason) })),
    message: "",
    saving: false
  };
  ui.capture = null;
  elements.hotkeyModal.classList.add("is-visible");
  renderHotkeyEditor();
  void api("/api/hotkeys/suspend", { method: "POST" }).catch(() => {});
}

function closeHotkeyEditor({ resume = true } = {}) {
  ui.capture = null;
  ui.hotkeyEditor = null;
  elements.hotkeyModal.classList.remove("is-visible");
  if (resume) void api("/api/hotkeys/resume", { method: "POST" }).catch(() => {});
}

function duplicateKeys(editor) {
  const seen = new Map();
  const duplicates = new Set();
  const all = [editor.activator, editor.undo, ...editor.rows.map((row) => row.keys)].filter(Boolean);
  for (const keys of all) {
    if (seen.has(keys)) duplicates.add(keys);
    else seen.set(keys, true);
  }
  return duplicates;
}

function renderHotkeyEditor() {
  const editor = ui.hotkeyEditor;
  if (!editor) return;
  const duplicates = duplicateKeys(editor);
  const canSave = !editor.saving && duplicates.size === 0;

  const rowNode = (label, keys, target) =>
    el(
      "div",
      { class: "recent-item", style: "grid-template-columns: 140px minmax(0, 1fr) auto auto" },
      el("span", { text: label, style: "font-weight: 600" }),
      el("span", { class: duplicates.has(keys) ? "tag pending" : "tag", text: keys || "未设置" }),
      el("button", {
        class: "btn",
        type: "button",
        text: ui.capture && ui.capture.key === target ? "请按组合键…" : "录制",
        onclick: () => {
          ui.capture = { key: target, label };
          renderHotkeyEditor();
        }
      }),
      el("button", {
        class: "btn-link",
        type: "button",
        text: "清除",
        onclick: () => {
          const row = editor.rows.find((item) => `reason:${item.reason}` === target);
          if (row) row.keys = "";
          if (target === "undo") editor.undo = "";
          if (target === "activator") editor.activator = "";
          editor.message = "";
          renderHotkeyEditor();
        }
      })
    );

  const rows = [
    rowNode("启动标记模式", editor.activator, "activator"),
    rowNode("撤销上一条", editor.undo, "undo")
  ];
  const directRows = editor.rows.map((row) => rowNode(`${row.reason}（直配）`, row.keys, `reason:${row.reason}`));

  const armInput = el("input", { type: "number", min: 3, max: 30, value: String(editor.armSeconds), style: "max-width: 100px" });
  armInput.addEventListener("input", () => {
    editor.armSeconds = Number(armInput.value) || 8;
  });

  const saveButton = el("button", { class: "btn btn-primary", type: "button", text: "保存", disabled: !canSave });
  saveButton.addEventListener("click", () => void saveHotkeyEditor());
  const resetButton = el("button", { class: "btn", type: "button", text: "恢复默认", onclick: () => void resetHotkeyEditor() });
  const cancelButton = el("button", { class: "btn", type: "button", text: "取消", onclick: () => closeHotkeyEditor() });

  elements.hotkeyBody.replaceChildren(
    el("div", { class: "banner info", text: "点击「录制」后直接按组合键。字母/数字需配合 Ctrl、Alt、Shift 或 Win；F1-F12 可以单独用。打开本窗口期间全局快捷键已暂停，不会误标记。" }),
    ...rows,
    el("div", { class: "field", style: "max-width: 260px" }, el("label", { text: "标记模式保持时间（秒）" }), armInput),
    el("div", { class: "hint", text: "下面这些是可选方案：给单个原因直接配组合键，不用经过「先按启动键」。" }),
    ...directRows,
    duplicates.size > 0 ? el("div", { class: "banner warn", text: `有重复的快捷键：${[...duplicates].join("、")}，请先改掉` }) : null,
    editor.message ? el("div", { class: editor.message.startsWith("已设置") ? "banner info" : "banner error", text: editor.message }) : null,
    el(
      "div",
      { style: "display: flex; gap: 8px; align-items: center; margin-top: 4px" },
      saveButton,
      resetButton,
      cancelButton,
      el("span", { class: "hint", text: "留空的项表示不绑定" })
    )
  );
}

function keySpecFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  const code = event.code || "";
  let main = "";
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key || "")) main = event.key.toUpperCase();
  else {
    main =
      {
        " ": "Space",
        Tab: "Tab",
        Enter: "Enter",
        Backspace: "Backspace",
        Insert: "Insert",
        Delete: "Delete",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right"
      }[event.key] || "";
  }
  if (!main) return "";
  parts.push(main);
  return parts.join("+");
}

async function captureHotkey(event) {
  const capture = ui.capture;
  const editor = ui.hotkeyEditor;
  if (!capture || !editor) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    ui.capture = null;
    editor.message = "";
    renderHotkeyEditor();
    return;
  }
  const spec = keySpecFromEvent(event);
  if (!spec) return;
  try {
    const result = await api("/api/hotkeys/validate", { method: "POST", body: { keys: spec } });
    if (!result.valid) {
      editor.message = result.error;
      renderHotkeyEditor();
      return;
    }
    const target = capture.key;
    const row = editor.rows.find((item) => `reason:${item.reason}` === target);
    if (row) row.keys = result.label;
    if (target === "undo") editor.undo = result.label;
    if (target === "activator") editor.activator = result.label;
    editor.message = `已设置 ${capture.label} → ${result.label}`;
    ui.capture = null;
    renderHotkeyEditor();
  } catch (error) {
    editor.message = error.message;
    renderHotkeyEditor();
  }
}

async function saveHotkeyEditor() {
  const editor = ui.hotkeyEditor;
  if (!editor) return;
  editor.saving = true;
  renderHotkeyEditor();
  try {
    const bindings = editor.rows.filter((row) => row.keys).map((row) => ({ reason: row.reason, keys: row.keys }));
    await api("/api/settings", {
      method: "POST",
      body: {
        hotkeyActivator: editor.activator,
        hotkeyArmSeconds: editor.armSeconds,
        hotkeyUndo: editor.undo,
        hotkeyBindings: bindings
      }
    });
    closeHotkeyEditor({ resume: false });
    await api("/api/hotkeys/resume", { method: "POST" }).catch(() => {});
    toast("快捷键已保存并重新注册", "ok");
    await refresh();
  } catch (error) {
    editor.saving = false;
    editor.message = error.message;
    renderHotkeyEditor();
  }
}

async function resetHotkeyEditor() {
  try {
    await api("/api/settings", { method: "POST", body: { resetHotkeys: true } });
    await api("/api/hotkeys/resume", { method: "POST" }).catch(() => {});
    closeHotkeyEditor({ resume: false });
    toast("已恢复默认快捷键", "ok");
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function refresh() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  try {
    render(await api("/api/state"));
  } catch (error) {
    elements.statusPill.className = "status-pill is-bad";
    elements.statusText.textContent = "面板未响应";
  } finally {
    ui.refreshing = false;
  }
}

async function submitMark() {
  if (ui.busy) return;
  const target = ui.state ? currentTarget(ui.state) : null;
  if (!target || !ui.selectedReason) return;
  ui.busy = true;
  updateSubmitState();
  try {
    const result = await api("/api/mark", {
      method: "POST",
      body: {
        trackingNumber: target.trackingNumber,
        sessionId: target.sessionId,
        recordingId: target.recordingId,
        reason: ui.selectedReason,
        note: elements.note.value,
        operator: elements.operator.value
      }
    });
    const record = result.record || {};
    const watermark = result.watermark || {};
    if (watermark.written) {
      toast(`已标记 ${record.trackingNumber} · ${record.reason}，并写入录像水印`, "ok");
    } else {
      toast(`已保存 ${record.trackingNumber} · ${record.reason}；${watermark.message || "水印未写入"}`, "");
    }
    elements.note.value = "";
    ui.selectedReason = "";
  } catch (error) {
    toast(error.message, "error");
  } finally {
    ui.busy = false;
    await refresh();
  }
}

async function saveOperator() {
  ui.operatorTouched = true;
  try {
    await api("/api/settings", { method: "POST", body: { operator: elements.operator.value } });
    await refresh();
  } catch (error) {
    toast(`保存操作员失败：${error.message}`, "error");
  }
}

async function reauthorize() {
  elements.reauth.disabled = true;
  elements.reauth.textContent = "等待电脑端确认…";
  toast("已在电脑端发起授权请求，请在 PackingProof 弹窗中确认", "");
  try {
    const result = await api("/api/enroll", { method: "POST" });
    if (result.ok) {
      toast("授权成功", "ok");
    } else {
      toast(result.auth?.message || "授权未完成", "error");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.reauth.disabled = false;
    elements.reauth.textContent = "重新授权";
    await refresh();
  }
}

elements.submit.addEventListener("click", () => void submitMark());
elements.operator.addEventListener("change", () => void saveOperator());
elements.operator.addEventListener("input", () => {
  ui.operatorTouched = true;
});
elements.reauth.addEventListener("click", () => void reauthorize());
elements.editHotkeys.addEventListener("click", () => openHotkeyEditor());

elements.restartPanel.addEventListener("click", async () => {
  if (!window.confirm("重启插件？面板会断开几秒，然后由后台隐藏进程接管。")) return;
  try {
    await api("/api/system/restart", { method: "POST" });
    toast("正在重启，几秒后刷新本页即可", "ok");
  } catch (error) {
    toast(error.message, "error");
  }
});

elements.stopPanel.addEventListener("click", async () => {
  if (!window.confirm("停止插件？停止后快捷键和面板都会失效，直到下次开机或手动启动。")) return;
  try {
    await api("/api/system/shutdown", { method: "POST" });
    toast("已停止。可用开始菜单/启动项，或双击 start.cmd 再启动", "ok");
  } catch (error) {
    toast(error.message, "error");
  }
});

elements.retryFirewall.addEventListener("click", async () => {
  elements.retryFirewall.disabled = true;
  elements.retryFirewall.textContent = "等待管理员确认…";
  try {
    const result = await api("/api/system/firewall", { method: "POST" });
    toast(result.ok ? "防火墙已放行 8792，手机可直接访问" : `放行失败：${result.firewall?.message || "未知原因"}`, result.ok ? "ok" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.retryFirewall.disabled = false;
    elements.retryFirewall.textContent = "重试放行防火墙";
    await refresh();
  }
});

elements.toggleOverlay.addEventListener("click", async () => {
  const enabled = !(ui.state?.overlay?.running);
  elements.toggleOverlay.disabled = true;
  try {
    const result = await api("/api/overlay", { method: "POST", body: { enabled } });
    toast(enabled ? (result.overlay?.ok ? "悬浮标记条已显示，可拖到录制窗口旁边" : `启动失败：${result.overlay?.message || ""}`) : "悬浮标记条已关闭", enabled && result.overlay?.ok ? "ok" : "");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.toggleOverlay.disabled = false;
    await refresh();
  }
});

elements.toggleAutoStart.addEventListener("click", async () => {
  const enabled = !(ui.state?.system?.autoStart?.enabled);
  elements.toggleAutoStart.disabled = true;
  try {
    await api("/api/settings", { method: "POST", body: { autoStart: enabled } });
    toast(enabled ? "已加入开机启动（下次登录自动运行）" : "已取消开机自启", "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.toggleAutoStart.disabled = false;
    await refresh();
  }
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => closeHotkeyEditor());
}
elements.hotkeyModal.addEventListener("click", (event) => {
  if (event.target === elements.hotkeyModal) closeHotkeyEditor();
});

document.addEventListener(
  "keydown",
  (event) => {
    if (ui.capture) void captureHotkey(event);
  },
  true
);

document.addEventListener("keydown", (event) => {
  if (ui.hotkeyEditor) {
    if (event.key === "Escape" && !ui.capture) closeHotkeyEditor();
    return;
  }
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (event.key === "Enter" && tag === "INPUT") {
      event.preventDefault();
      void submitMark();
    }
    return;
  }
  const index = Number(event.key);
  if (Number.isInteger(index) && index >= 1 && index <= ui.reasons.length) {
    selectReason(ui.reasons[index - 1]);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void submitMark();
  }
  if (event.key === "Escape") {
    ui.selectedReason = "";
    elements.note.value = "";
    renderReasonSelection();
    updateSubmitState();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});

void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 1000);
