const REMOTE_RELAY_URL = getRelayUrl();
const PUBLISH_MIN_MS = 500;

const els = {};
const rows = [];

let scenario = "idle";
let scenarioStartedAt = Date.now();
let motionStartedAt = 0;
let packetCount = 0;
let lastRowAt = 0;
let lastPublishAt = 0;

const scenarios = {
  idle: {
    phase: "idle",
    label: "待初始化",
    labelClass: "idle",
    text: "测试页待机。",
    score: 0,
    scale: 0,
    active: false,
    motionLevel: "等待数据",
    status: "未建立",
    rssi: "--",
    ampShift: "0.00",
    change: ["idle", "待初始化", "归一化 CSI 形态漂移检测", 0, "--"],
    paper: ["idle", "待初始化", "Doppler-NMI 图与 QAOA 分区映射", 0, "--"],
    combined: ["idle", "待初始化", "双门控 OR 融合与时间持续性判决", 0, "连续确认"],
  },
  stable: {
    phase: "monitoring",
    label: "静稳环境",
    labelClass: "stable",
    text: "模拟 CSI 动态特征接近电磁环境投影。",
    score: 12,
    scale: 12,
    active: false,
    motionLevel: "静稳环境",
    status: "投影已建立",
    rssi: "-47 dBm",
    ampShift: "0.06",
    change: ["clear", "投影一致", "CSI 形态接近电磁环境投影", 21, 45],
    paper: ["clear", "图响应稳定", "未发现持续 Doppler 动态分量", 8, 48],
    combined: ["clear", "无人活动", "双门控均未连续触发", 12, "连续确认"],
  },
  weak: {
    phase: "monitoring",
    label: "微动作",
    labelClass: "weak",
    text: "模拟单门控候选响应，等待持续性确认。",
    score: 38,
    scale: 38,
    active: true,
    motionLevel: "微动作",
    status: "投影已建立",
    rssi: "-49 dBm",
    ampShift: "1.18",
    change: ["wait", "候选响应", "归一化 CSI 有轻微偏离", 42, 45],
    paper: ["clear", "图响应稳定", "未发现持续 Doppler 动态分量", 22, 48],
    combined: ["wait", "等待确认", "单门控响应，等待持续性确认", 38, "连续确认"],
  },
  medium: {
    phase: "monitoring",
    label: "中等活动",
    labelClass: "medium",
    text: "模拟 Doppler-NMI 与 CSI 投影均出现持续动态响应。",
    score: 66,
    scale: 66,
    active: true,
    motionLevel: "中等活动",
    status: "投影已建立",
    rssi: "-51 dBm",
    ampShift: "2.63",
    change: ["hit", "门控触发", "归一化 CSI 动态连续偏离投影", 69, 45],
    paper: ["hit", "图门控触发", "检测到非零 Doppler 动态分量", 61, 48],
    combined: ["hit", "有人活动", "任一门控持续触发后提醒", 66, "连续确认"],
  },
  strong: {
    phase: "monitoring",
    label: "强活动",
    labelClass: "strong",
    text: "模拟持续人体活动引起的显著电磁环境变化。",
    score: 89,
    scale: 89,
    active: true,
    motionLevel: "强活动",
    status: "投影已建立",
    rssi: "-54 dBm",
    ampShift: "4.21",
    change: ["hit", "门控触发", "归一化 CSI 动态连续偏离投影", 91, 45],
    paper: ["hit", "图门控触发", "检测到非零 Doppler 动态分量", 86, 48],
    combined: ["hit", "有人活动", "任一门控持续触发后提醒", 89, "连续确认"],
  },
};

document.addEventListener("DOMContentLoaded", () => {
  [
    "serialStatus",
    "presenceState",
    "presenceText",
    "presenceScore",
    "scoreFill",
    "calibStatus",
    "packetCount",
    "rssiValue",
    "ampShift",
    "changeCard",
    "changeStatus",
    "changeText",
    "changeScore",
    "changeThreshold",
    "paperCard",
    "paperStatus",
    "paperText",
    "paperScore",
    "paperThreshold",
    "combinedCard",
    "combinedStatus",
    "combinedText",
    "combinedScore",
    "combinedThreshold",
    "motionOrb",
    "motionScale",
    "motionLevel",
    "motionDuration",
    "motionTimelineBody",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => setScenario(button.dataset.scenario));
  });

  setScenario("idle");
  window.setInterval(tick, 250);
});

function setScenario(nextScenario) {
  scenario = nextScenario;
  scenarioStartedAt = Date.now();
  if (nextScenario === "idle") {
    rows.length = 0;
    motionStartedAt = 0;
  }
  if (nextScenario === "prep") {
    motionStartedAt = 0;
  }
  if (["weak", "medium", "strong"].includes(nextScenario)) {
    motionStartedAt = Date.now();
  }
  tick(true);
}

function tick(force = false) {
  packetCount += scenario === "idle" ? 0 : 8;

  if (scenario === "prep") {
    renderPrep();
  } else {
    renderScenario(scenarios[scenario] || scenarios.idle);
  }

  publishRemote(force);
}

function renderPrep() {
  const elapsed = Date.now() - scenarioStartedAt;
  const remain = Math.max(0, Math.ceil((5000 - elapsed) / 1000));
  if (elapsed >= 5000) {
    setScenario("stable");
    return;
  }
  const item = {
    ...scenarios.stable,
    phase: "preparing",
    label: "准备空场",
    labelClass: "baseline",
    text: `准备倒计时 ${remain} 秒。倒计时结束后进入模拟静稳环境。`,
    score: 0,
    scale: 0,
    active: false,
    motionLevel: "准备空场",
    status: `准备 ${Math.min(5, Math.floor(elapsed / 1000))}/5 秒`,
    change: ["wait", "准备空场", "暂不写入投影样本", 0, "--"],
    paper: ["wait", "等待预热", `准备倒计时 ${remain} 秒`, 0, "--"],
    combined: ["wait", "尚未判决", "5 秒后进入模拟投影", 0, "连续确认"],
  };
  renderScenario(item, `准备倒计时 ${remain} 秒`);
}

function renderScenario(item, durationText) {
  setStateLabel(item.label, item.labelClass);
  els.presenceText.textContent = item.text;
  els.presenceScore.textContent = String(item.score);
  els.scoreFill.style.width = `${item.score}%`;
  els.calibStatus.textContent = item.status;
  els.packetCount.textContent = String(packetCount);
  els.rssiValue.textContent = item.rssi;
  els.ampShift.textContent = item.ampShift;
  setLayer("change", item.change);
  setLayer("paper", item.paper);
  setLayer("combined", item.combined);
  renderMotion(item, durationText);
}

function renderMotion(item, durationText) {
  const now = Date.now();
  if (!item.active) motionStartedAt = 0;
  const duration = item.active && motionStartedAt ? formatDuration(now - motionStartedAt) : "0.0 秒";
  els.motionOrb.style.setProperty("--motion-scale", String(item.scale));
  els.motionOrb.classList.toggle("active", item.active);
  els.motionScale.textContent = String(item.scale);
  els.motionLevel.textContent = item.motionLevel;
  els.motionDuration.textContent = durationText || `持续时间 ${duration}`;

  if (item.active && now - lastRowAt >= 1000) {
    lastRowAt = now;
    rows.unshift({
      time: new Date(now).toLocaleTimeString("zh-CN", { hour12: false }),
      label: item.motionLevel,
      scale: item.scale,
      duration,
      trigger: item.scale >= 60 ? "双门控" : "候选波动",
    });
    rows.splice(7);
  }
  renderRows();
}

function renderRows() {
  if (!rows.length) {
    els.motionTimelineBody.innerHTML = '<tr><td colspan="4">有动作时自动记录</td></tr>';
    return;
  }
  els.motionTimelineBody.innerHTML = rows
    .map(
      (row) =>
        `<tr><td>${row.time}</td><td class="scale-cell"><strong>${row.label}</strong><small>${row.scale}/100</small></td><td>${row.duration}</td><td>${row.trigger}</td></tr>`,
    )
    .join("");
}

function setLayer(prefix, values) {
  const [className, status, text, score, threshold] = values;
  els[`${prefix}Card`].className = `alert-card ${className}`;
  els[`${prefix}Status`].textContent = status;
  els[`${prefix}Text`].textContent = text;
  els[`${prefix}Score`].textContent = String(score);
  els[`${prefix}Threshold`].textContent = String(threshold);
}

function setStateLabel(text, className) {
  els.presenceState.textContent = text;
  els.presenceState.className = `judgement ${className}`;
}

function publishRemote(force = false) {
  const now = Date.now();
  if (!force && now - lastPublishAt < PUBLISH_MIN_MS) return;
  lastPublishAt = now;
  const endpoint = `${REMOTE_RELAY_URL.replace(/\/$/, "")}/api/state`;
  const payload = buildPayload(now);
  const body = JSON.stringify(payload);
  if (typeof fetch === "function") {
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  }
}

function buildPayload(now) {
  const item = scenario === "prep" ? { ...scenarios.stable, phase: "preparing", active: false } : scenarios[scenario] || scenarios.idle;
  return {
    phase: item.phase,
    source: "test-page",
    localTime: now,
    pageTitle: document.title,
    presenceLabel: els.presenceState.textContent,
    present: ["medium", "strong"].includes(scenario),
    score: Number(els.presenceScore.textContent) || 0,
    text: els.presenceText.textContent,
    serialStatus: els.serialStatus.textContent,
    packetCount,
    rssi: els.rssiValue.textContent,
    ampShift: els.ampShift.textContent,
    motionScale: els.motionScale.textContent,
    motionLevel: els.motionLevel.textContent,
    motionDuration: els.motionDuration.textContent,
    change: layerPayload("change"),
    paper: layerPayload("paper"),
    combined: layerPayload("combined"),
  };
}

function layerPayload(prefix) {
  return {
    status: els[`${prefix}Status`].textContent,
    text: els[`${prefix}Text`].textContent,
    score: els[`${prefix}Score`].textContent,
    threshold: els[`${prefix}Threshold`].textContent,
  };
}

function getRelayUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("relay") || localStorage.getItem("csiRemoteRelayUrl") || "http://127.0.0.1:8091";
  } catch (_error) {
    return "http://127.0.0.1:8091";
  }
}

function formatDuration(durationMs) {
  const seconds = Math.max(0, durationMs / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}
