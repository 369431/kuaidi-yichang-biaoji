/* Exception handling page: status workflow, notes, CSV export and recording evidence. */

const STATUS_LABELS = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  ignored: "已忽略"
};

const view = {
  records: [],
  stats: {},
  settings: { operator: "" },
  auth: {},
  page: 1,
  size: 50,
  total: 0,
  busy: false,
  evidenceTimer: null
};

const nodes = {
  rows: document.getElementById("rows"),
  empty: document.getElementById("empty"),
  stats: document.getElementById("stats"),
  totalHint: document.getElementById("totalHint"),
  pageHint: document.getElementById("pageHint"),
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  filterStatus: document.getElementById("filterStatus"),
  filterFrom: document.getElementById("filterFrom"),
  filterTo: document.getElementById("filterTo"),
  filterQuery: document.getElementById("filterQuery"),
  handleModal: document.getElementById("handleModal"),
  handleBody: document.getElementById("handleBody"),
  evidenceModal: document.getElementById("evidenceModal"),
  evidenceBody: document.getElementById("evidenceBody"),
  toast: document.getElementById("toast")
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
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
  nodes.toast.textContent = message;
  nodes.toast.className = `toast is-visible ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    nodes.toast.className = "toast";
  }, kind === "error" ? 6000 : 4000);
}

function formatTime(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size <= 0) return "";
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function queryString() {
  const params = new URLSearchParams();
  const status = nodes.filterStatus.value;
  if (status) params.set("status", status);
  if (nodes.filterFrom.value) params.set("from", nodes.filterFrom.value);
  if (nodes.filterTo.value) params.set("to", nodes.filterTo.value);
  const keyword = nodes.filterQuery.value.trim();
  if (keyword) params.set("q", keyword);
  params.set("page", String(view.page));
  params.set("size", String(view.size));
  return params.toString();
}

async function loadState() {
  const state = await api("/api/state");
  view.settings = state.settings || { operator: "" };
  view.auth = state.auth || {};
  renderConnection(state);
}

function renderConnection(state) {
  const authorized = state?.auth?.status === "authorized";
  nodes.statusPill.className = "status-pill";
  if (!authorized) {
    nodes.statusPill.classList.add("is-bad");
    nodes.statusText.textContent = "未授权";
  } else if (state?.watcher?.status === "error") {
    nodes.statusPill.classList.add("is-bad");
    nodes.statusText.textContent = "主机连接失败";
  } else {
    nodes.statusText.textContent = state?.watcher?.current ? "录像中" : "已连接";
    nodes.statusPill.classList.toggle("is-live", Boolean(state?.watcher?.current));
  }
}

async function load() {
  try {
    const data = await api(`/api/records?${queryString()}`);
    view.records = data.records || [];
    view.total = data.total || 0;
    renderStats(data.stats || {});
    renderRows();
    renderPager();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderStats(stats) {
  const cards = [
    ["待处理", stats.pending || 0, "pending"],
    ["处理中", stats.processing || 0, "processing"],
    ["已处理", stats.resolved || 0, "resolved"],
    ["今日新增", stats.today || 0, ""],
    ["累计异常", stats.total || 0, ""]
  ];
  nodes.stats.replaceChildren(
    ...cards.map(([label, value]) =>
      el("div", { class: "stat" }, el("div", { class: "label", text: label }), el("div", { class: "value", text: String(value) }))
    )
  );
}

function statusTag(record) {
  if (record.voided) return el("span", { class: "tag revoked", text: "已撤销" });
  return el("span", { class: `tag ${record.status}`, text: STATUS_LABELS[record.status] || record.status });
}

function renderRows() {
  nodes.empty.hidden = view.records.length > 0;
  nodes.totalHint.textContent = view.total > 0 ? `共 ${view.total} 条` : "";
  nodes.rows.replaceChildren(
    ...view.records.map((record) =>
      el(
        "tr",
        {},
        el("td", { class: "code" }, record.trackingNumber),
        el("td", { text: record.reason || "" }),
        el("td", { text: record.note || "" }),
        el("td", {}, statusTag(record)),
        el("td", { text: record.operator || "" }),
        el("td", { text: formatTime(record.createdAt) }),
        el("td", { text: record.handlingNote || "" }),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            record.voided
              ? null
              : el("button", { class: "btn-link", type: "button", onclick: () => openHandle(record.id) }, "处理"),
            record.voided
              ? null
              : el(
                  "button",
                  {
                    class: "btn-link",
                    type: "button",
                    onclick: () => void revokeRecord(record.id, record.trackingNumber)
                  },
                  "撤销"
                ),
            el(
              "button",
              { class: "btn-link", type: "button", onclick: () => void openEvidence(record.trackingNumber) },
              "录像"
            )
          )
        )
      )
    )
  );
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(view.total / view.size));
  nodes.pageHint.textContent = `第 ${view.page} / ${pages} 页`;
  document.getElementById("prev").disabled = view.page <= 1;
  document.getElementById("next").disabled = view.page >= pages;
}

function closeModal(modal) {
  modal.classList.remove("is-visible");
  if (modal === nodes.evidenceModal) {
    clearTimeout(view.evidenceTimer);
    view.evidenceTimer = null;
    nodes.evidenceBody.replaceChildren();
  }
}

function openHandle(id) {
  const record = view.records.find((item) => item.id === id);
  if (!record) return;
  let selectedStatus = record.status;

  const statusButtons = el(
    "div",
    { class: "status-buttons" },
    ...Object.entries(STATUS_LABELS).map(([value, label]) =>
      el("button", {
        class: "btn",
        type: "button",
        text: label,
        attrs: { "aria-pressed": String(value === selectedStatus) },
        onclick: (event) => {
          selectedStatus = value;
          for (const button of statusButtons.querySelectorAll("button")) {
            button.setAttribute("aria-pressed", String(button.textContent === STATUS_LABELS[selectedStatus]));
          }
        }
      })
    )
  );

  const noteInput = el("textarea", { rows: 3, maxLength: 1000, placeholder: "例如：已联系买家补发，10-20 已发出" });
  noteInput.value = record.handlingNote || "";
  const operatorInput = el("input", { type: "text", maxLength: 40, placeholder: "处理人" });
  operatorInput.value = record.handler || view.settings.operator || "";

  const saveButton = el("button", { class: "btn btn-primary", type: "button", text: "保存处理结果" });
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      await api("/api/status", {
        method: "POST",
        body: {
          id: record.id,
          status: selectedStatus,
          handlingNote: noteInput.value,
          operator: operatorInput.value
        }
      });
      closeModal(nodes.handleModal);
      toast("处理结果已保存", "ok");
      await Promise.all([load(), loadState()]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  nodes.handleBody.replaceChildren(
    el(
      "div",
      { class: "banner info" },
      `${record.trackingNumber} · ${record.reason || ""}${record.note ? ` · ${record.note}` : ""}`
    ),
    el(
      "div",
      { class: "meta-row" },
      el("span", { text: `标记时间 ${formatTime(record.createdAt)}` }),
      el("span", { text: `标记人 ${record.operator || "未署名"}` }),
      el("span", { text: record.watermark ? "水印已写入" : `水印未写入：${record.watermarkMessage || ""}` })
    ),
    el("div", { class: "field" }, el("label", { text: "处理状态" }), statusButtons),
    el("div", { class: "field" }, el("label", { text: "处理备注" }), noteInput),
    el("div", { class: "field", style: "max-width: 260px" }, el("label", { text: "处理人" }), operatorInput),
    el("div", { style: "display: flex; gap: 8px; align-items: center" }, saveButton, el("span", { class: "hint", text: "保存后可在列表按状态筛选" })),
    renderHistory(record)
  );
  nodes.handleModal.classList.add("is-visible");
  noteInput.focus();
}

function renderHistory(record) {
  const history = Array.isArray(record.history) ? record.history.slice(-8).reverse() : [];
  if (history.length === 0) return el("div", { class: "hint", text: "暂无处理轨迹" });
  return el(
    "div",
    { class: "field" },
    el("label", { text: "处理轨迹" }),
    el(
      "ul",
      { class: "history" },
      ...history.map((item) =>
        el(
          "li",
          {},
          el("span", { class: "mono", text: formatTime(item.at) }),
          el("span", { text: `${actionLabel(item.action)}${item.operator ? ` · ${item.operator}` : ""}` }),
          el("span", { text: item.detail || "" })
        )
      )
    )
  );
}

function actionLabel(action) {
  return (
    {
      marked: "标记",
      updated: "更新标记",
      revoked: "撤销",
      status: "状态变更",
      note: "备注"
    }[action] || action
  );
}

async function revokeRecord(id, trackingNumber) {
  if (!window.confirm(`撤销 ${trackingNumber} 的异常标记？记录会保留，状态变为已忽略。`)) return;
  try {
    const result = await api("/api/revoke", { method: "POST", body: { id, operator: view.settings.operator } });
    toast(result.watermark?.written ? "已撤销，并改写录像水印" : `已撤销；${result.watermark?.message || ""}`, "ok");
    await load();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openEvidence(trackingNumber) {
  nodes.evidenceBody.replaceChildren(el("div", { class: "hint", text: `正在向 PackingProof 查询 ${trackingNumber} 的录像…` }));
  nodes.evidenceModal.classList.add("is-visible");
  try {
    const started = await api("/api/evidence", { method: "POST", body: { trackingNumber } });
    await pollEvidence(started.snapshot?.queryId, 0);
  } catch (error) {
    nodes.evidenceBody.replaceChildren(el("div", { class: "banner error", text: error.message }));
  }
}

async function pollEvidence(queryId, attempt) {
  if (!queryId) return;
  clearTimeout(view.evidenceTimer);
  if (attempt > 80) {
    nodes.evidenceBody.replaceChildren(el("div", { class: "banner warn", text: "查询超时，请稍后重试" }));
    return;
  }
  let snapshot;
  try {
    snapshot = (await api(`/api/evidence/${encodeURIComponent(queryId)}`)).snapshot;
  } catch (error) {
    nodes.evidenceBody.replaceChildren(el("div", { class: "banner error", text: error.message }));
    return;
  }
  renderEvidence(queryId, snapshot);
  if (["queued", "searching", "preparing"].includes(snapshot?.status)) {
    view.evidenceTimer = setTimeout(() => void pollEvidence(queryId, attempt + 1), 1000);
  }
}

function renderEvidence(queryId, snapshot) {
  const status = snapshot?.status || "";
  const children = [];
  if (status === "not_found") {
    children.push(el("div", { class: "banner warn", text: "PackingProof 没有找到这个单号的录像" }));
  } else if (status === "failed" || status === "expired") {
    children.push(el("div", { class: "banner error", text: snapshot?.message || "录像查询失败" }));
  } else if (["queued", "searching", "preparing"].includes(status)) {
    children.push(el("div", { class: "banner info", text: `${snapshot?.message || "正在准备录像"}${snapshot?.progress ? `（${snapshot.progress}%）` : ""}` }));
  } else if (status === "ready" || status === "downloading" || status === "completed") {
    children.push(el("div", { class: "hint", text: `共 ${snapshot?.totalMatches || 0} 段录像` }));
  }

  const recordings = Array.isArray(snapshot?.recordings) ? snapshot.recordings : [];
  const list = el("ul", { class: "evidence-list" });
  for (const item of recordings) {
    const playable = ["ready", "completed"].includes(item.status) && item.downloadUrl;
    const videoHolder = el("div", { style: "width: 100%" });
    const playButton = el("button", {
      class: "btn",
      type: "button",
      text: "播放",
      disabled: !playable,
      onclick: () => {
        videoHolder.replaceChildren();
        const video = el("video", {
          controls: true,
          preload: "metadata",
          src: `/api/evidence/${encodeURIComponent(queryId)}/${item.recordingId}/stream`
        });
        videoHolder.appendChild(video);
        void video.play().catch(() => {});
      }
    });
    list.appendChild(
      el(
        "li",
        { class: "evidence-item" },
        el("span", { text: formatTime(item.recordedAt) || item.fileName || `录像 ${item.recordingId}` }),
        el("span", { class: "hint", text: [`${Number(item.durationSeconds) || 0}s`, formatBytes(item.fileSizeBytes), item.videoCodec].filter(Boolean).join(" · ") }),
        el("span", { class: `tag ${item.status === "failed" ? "pending" : "resolved"}`, text: item.status }),
        playButton,
        el(
          "a",
          {
            class: "btn-link",
            href: `/api/evidence/${encodeURIComponent(queryId)}/${item.recordingId}/stream`,
            attrs: { download: "" }
          },
          "下载"
        ),
        videoHolder
      )
    );
  }
  if (recordings.length > 0) children.push(list);
  nodes.evidenceBody.replaceChildren(...children);
}

document.getElementById("search").addEventListener("click", () => {
  view.page = 1;
  void load();
});
document.getElementById("reset").addEventListener("click", () => {
  nodes.filterStatus.value = "";
  nodes.filterFrom.value = "";
  nodes.filterTo.value = "";
  nodes.filterQuery.value = "";
  view.page = 1;
  void load();
});
document.getElementById("export").addEventListener("click", () => {
  const params = new URLSearchParams(queryString());
  params.delete("page");
  params.delete("size");
  window.location.href = `/api/export.csv?${params.toString()}`;
});
document.getElementById("prev").addEventListener("click", () => {
  view.page = Math.max(1, view.page - 1);
  void load();
});
document.getElementById("next").addEventListener("click", () => {
  view.page += 1;
  void load();
});
nodes.filterQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    view.page = 1;
    void load();
  }
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => closeModal(document.getElementById(button.dataset.close)));
}
for (const modal of [nodes.handleModal, nodes.evidenceModal]) {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal(modal);
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (nodes.handleModal.classList.contains("is-visible")) closeModal(nodes.handleModal);
  else if (nodes.evidenceModal.classList.contains("is-visible")) closeModal(nodes.evidenceModal);
});

void (async () => {
  try {
    await loadState();
  } catch (error) {
    toast(error.message, "error");
  }
  await load();
})();
setInterval(() => {
  if (document.hidden) return;
  void loadState().catch(() => {});
}, 5000);
