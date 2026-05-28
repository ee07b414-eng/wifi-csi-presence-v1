const REMOTE_RELAY_URL = getRelayUrl();
const PUBLISH_MIN_MS = 500;

const profiles = {
  low: { label: "低码率", fps: 8, payloadBytes: 12000 },
  balanced: { label: "均衡码率", fps: 12, payloadBytes: 22000 },
  high: { label: "高码率", fps: 18, payloadBytes: 36000 },
};

const channels = {
  good: { label: "良好信道", loss: 0.01, latency: 28, jitter: 6, factor: 1 },
  congested: { label: "拥塞信道", loss: 0.08, latency: 92, jitter: 28, factor: 0.72 },
  fading: { label: "衰落信道", loss: 0.18, latency: 142, jitter: 58, factor: 0.5 },
};

const sensingModes = {
  stable: {
    label: "静稳环境",
    className: "stable",
    score: 12,
    text: "CSI 动态特征接近电磁环境投影，通信业务流未引起人体活动判定。",
    change: ["clear", "投影一致", "CSI 形态接近电磁环境投影", 24, 45],
    paper: ["clear", "图响应稳定", "未发现持续 Doppler 动态分量", 8, 48],
    combined: ["clear", "无人活动", "通信业务存在，但感知链路保持静稳", 12, "连续确认"],
  },
  weak: {
    label: "微动作",
    className: "weak",
    score: 39,
    text: "检测到轻微电磁扰动，暂按候选动作记录。",
    change: ["wait", "候选响应", "归一化 CSI 有轻微偏离", 41, 45],
    paper: ["clear", "图响应稳定", "Doppler-NMI 未连续触发", 24, 48],
    combined: ["wait", "等待确认", "单门控候选响应，继续观察", 39, "连续确认"],
  },
  active: {
    label: "有人活动",
    className: "strong",
    score: 82,
    text: "CSI 投影与 Doppler-NMI 图均出现持续动态响应，判定为有人活动。",
    change: ["hit", "门控触发", "归一化 CSI 动态连续偏离投影", 84, 45],
    paper: ["hit", "图门控触发", "检测到非零 Doppler 动态分量", 79, 48],
    combined: ["hit", "有人活动", "通信业务流并行时仍检测到人体活动", 82, "连续确认"],
  },
};

const els = {};
const eventRows = [];
const deliveredBytes = [];
const deliveredFrames = [];
const latencies = [];

let running = false;
let profileKey = "balanced";
let channelKey = "good";
let sensingKey = "stable";
let lastFrameAt = 0;
let lastDrawAt = 0;
let frameSeq = 0;
let txFrames = 0;
let rxFrames = 0;
let droppedFrames = 0;
let lastPublishAt = 0;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  renderAll();
  requestAnimationFrame(loop);
  window.setInterval(() => {
    if (running) renderAll();
    publishRemote();
  }, 500);
});

function cacheElements() {
  [
    "linkStatus",
    "videoCanvas",
    "streamState",
    "frameId",
    "presenceState",
    "presenceText",
    "presenceScore",
    "scoreFill",
    "streamToggle",
    "throughput",
    "fps",
    "latency",
    "jitter",
    "lossRate",
    "linkScore",
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
    "eventRows",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  els.streamToggle.addEventListener("click", () => {
    running = !running;
    addEvent(running ? "业务流启动" : "业务流暂停");
    renderAll();
    publishRemote(true);
  });
  document.querySelectorAll("[data-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      profileKey = button.dataset.profile;
      addEvent(`码率切换：${profiles[profileKey].label}`);
      renderAll();
    });
  });
  document.querySelectorAll("[data-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      channelKey = button.dataset.channel;
      addEvent(`信道切换：${channels[channelKey].label}`);
      renderAll();
    });
  });
  document.querySelectorAll("[data-sensing]").forEach((button) => {
    button.addEventListener("click", () => {
      sensingKey = button.dataset.sensing;
      addEvent(`感知场景：${sensingModes[sensingKey].label}`);
      renderAll();
    });
  });
}

function loop(now) {
  if (running) {
    const profile = profiles[profileKey];
    const frameInterval = 1000 / profile.fps;
    if (now - lastFrameAt >= frameInterval) {
      lastFrameAt = now;
      simulateFrame(now);
    }
  }
  if (now - lastDrawAt >= 33) {
    lastDrawAt = now;
    drawVideo(now);
  }
  requestAnimationFrame(loop);
}

function simulateFrame(now) {
  const profile = profiles[profileKey];
  const channel = channels[channelKey];
  txFrames += 1;
  frameSeq += 1;
  const lost = Math.random() < channel.loss;
  if (lost) {
    droppedFrames += 1;
    return;
  }

  rxFrames += 1;
  const latency = Math.max(4, channel.latency + gaussianNoise() * channel.jitter);
  const bytes = Math.round(profile.payloadBytes * channel.factor);
  deliveredBytes.push({ time: now, bytes });
  deliveredFrames.push({ time: now });
  latencies.push(latency);
  trimMetrics(now);
}

function trimMetrics(now) {
  while (deliveredBytes.length && now - deliveredBytes[0].time > 1000) deliveredBytes.shift();
  while (deliveredFrames.length && now - deliveredFrames[0].time > 1000) deliveredFrames.shift();
  while (latencies.length > 60) latencies.shift();
}

function drawVideo(now) {
  const canvas = els.videoCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const profile = profiles[profileKey];
  const channel = channels[channelKey];
  const sensing = sensingModes[sensingKey];
  const t = now / 1000;

  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#17243a");
  gradient.addColorStop(0.5, channelKey === "fading" ? "#5b2333" : "#1f6fd2");
  gradient.addColorStop(1, "#f2b429");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 18; i += 1) {
    const x = (i * 47 + t * 46 * (i % 3 + 1)) % (width + 90) - 45;
    const y = 36 + ((i * 59 + t * 38) % (height - 72));
    ctx.fillStyle = `rgba(255, 255, 255, ${0.08 + (i % 5) * 0.025})`;
    ctx.fillRect(x, y, 72, 8 + (i % 3) * 4);
  }

  const orbX = width * 0.5 + Math.sin(t * 1.8) * width * 0.23;
  const orbY = height * 0.52 + Math.cos(t * 1.4) * height * 0.18;
  ctx.beginPath();
  ctx.arc(orbX, orbY, sensingKey === "active" ? 54 : 38, 0, Math.PI * 2);
  ctx.fillStyle = sensingKey === "stable" ? "#8ee2ae" : sensingKey === "weak" ? "#ffd95a" : "#ff7369";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#1b2632";
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "700 22px system-ui";
  ctx.fillText(`${profile.label} · ${channel.label}`, 24, 42);
  ctx.font = "800 42px system-ui";
  ctx.fillText(`CSI ${sensing.label}`, 24, 92);
  ctx.font = "600 18px system-ui";
  ctx.fillText(`Frame ${String(frameSeq).padStart(4, "0")} · RX ${rxFrames} / TX ${txFrames}`, 24, height - 30);

  if (!running) {
    ctx.fillStyle = "rgba(20, 32, 43, 0.62)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "850 44px system-ui";
    ctx.fillText("业务流暂停", width / 2 - 118, height / 2 + 14);
  }
}

function renderAll() {
  const metrics = computeMetrics();
  const sensing = sensingModes[sensingKey];
  els.linkStatus.textContent = running ? `${profiles[profileKey].label} · ${channels[channelKey].label}` : "业务流暂停";
  els.streamState.textContent = running ? "业务流传输中" : "业务流暂停";
  els.frameId.textContent = `Frame ${String(frameSeq).padStart(4, "0")}`;
  els.streamToggle.textContent = running ? "暂停业务流" : "启动业务流";
  els.streamToggle.classList.toggle("secondary", running);
  els.streamToggle.classList.toggle("danger", !running);

  els.presenceState.textContent = sensing.label;
  els.presenceState.className = `judgement ${sensing.className}`;
  els.presenceText.textContent = sensing.text;
  els.presenceScore.textContent = String(sensing.score);
  els.scoreFill.style.width = `${sensing.score}%`;

  els.throughput.textContent = metrics.throughput.toFixed(2);
  els.fps.textContent = metrics.fps.toFixed(1);
  els.latency.textContent = String(Math.round(metrics.latency));
  els.jitter.textContent = String(Math.round(metrics.jitter));
  els.lossRate.textContent = metrics.lossRate.toFixed(1);
  els.linkScore.textContent = String(metrics.linkScore);

  setLayer("change", sensing.change);
  setLayer("paper", sensing.paper);
  setLayer("combined", sensing.combined);
  renderRows();
}

function computeMetrics() {
  const byteSum = deliveredBytes.reduce((sum, item) => sum + item.bytes, 0);
  const throughput = (byteSum * 8) / 1_000_000;
  const fps = deliveredFrames.length;
  const latency = average(latencies);
  const jitter = stddev(latencies);
  const lossRate = txFrames ? (droppedFrames / txFrames) * 100 : 0;
  const linkScore = Math.round(clamp(100 - lossRate * 2.2 - Math.max(0, latency - 35) * 0.22 - jitter * 0.35, 0, 100));
  return { throughput, fps, latency, jitter, lossRate, linkScore };
}

function setLayer(prefix, values) {
  const [className, status, text, score, threshold] = values;
  els[`${prefix}Card`].className = `alert-card ${className}`;
  els[`${prefix}Status`].textContent = status;
  els[`${prefix}Text`].textContent = text;
  els[`${prefix}Score`].textContent = String(score);
  els[`${prefix}Threshold`].textContent = String(threshold);
}

function addEvent(text) {
  const metrics = computeMetrics();
  const now = new Date();
  eventRows.unshift({
    time: now.toLocaleTimeString("zh-CN", { hour12: false }),
    event: text,
    comm: `${metrics.throughput.toFixed(2)} Mbps / ${metrics.lossRate.toFixed(1)}% loss`,
    sensing: sensingModes[sensingKey].label,
  });
  eventRows.splice(8);
  renderRows();
}

function renderRows() {
  if (!eventRows.length) {
    els.eventRows.innerHTML = '<tr><td colspan="4">启动业务流后记录事件</td></tr>';
    return;
  }
  els.eventRows.innerHTML = eventRows
    .map((row) => `<tr><td>${row.time}</td><td>${row.event}</td><td>${row.comm}</td><td>${row.sensing}</td></tr>`)
    .join("");
}

function publishRemote(force = false) {
  const now = Date.now();
  if (!force && now - lastPublishAt < PUBLISH_MIN_MS) return;
  lastPublishAt = now;
  const metrics = computeMetrics();
  const sensing = sensingModes[sensingKey];
  const endpoint = `${REMOTE_RELAY_URL.replace(/\/$/, "")}/api/state`;
  const payload = {
    updatedAt: now,
    phase: running ? "isac_streaming" : "isac_idle",
    source: "isac-page",
    pageTitle: document.title,
    presenceLabel: sensing.label,
    present: sensingKey === "active",
    score: sensing.score,
    text: `${sensing.text} 通信性能：${metrics.throughput.toFixed(2)} Mbps，${metrics.fps.toFixed(1)} FPS，丢包 ${metrics.lossRate.toFixed(1)}%。`,
    serialStatus: els.linkStatus.textContent,
    packetCount: rxFrames,
    rssi: channels[channelKey].label,
    ampShift: `${metrics.throughput.toFixed(2)} Mbps`,
    motionScale: String(sensing.score),
    motionLevel: sensing.label,
    motionDuration: running ? "业务流传输中" : "业务流暂停",
    change: layerPayload("change"),
    paper: layerPayload("paper"),
    combined: layerPayload("combined"),
    isac: {
      running,
      profile: profiles[profileKey].label,
      channel: channels[channelKey].label,
      throughputMbps: metrics.throughput,
      fps: metrics.fps,
      latencyMs: metrics.latency,
      jitterMs: metrics.jitter,
      lossRate: metrics.lossRate,
      linkScore: metrics.linkScore,
      txFrames,
      rxFrames,
    },
  };
  fetch(endpoint, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
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

function gaussianNoise() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
