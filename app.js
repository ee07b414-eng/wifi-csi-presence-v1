const BAUD_RATE = 921600;
const PREPARE_MS = 5000;
const BASELINE_MS = 10000;
const WINDOW_MS = 1000;
const STEP_MS = 500;
const RETAIN_MS = 15000;
const MIN_BASELINE_PACKETS = 80;
const MIN_WINDOW_PACKETS = 12;
const PERSISTENCE_MS = 2600;
const PERSISTENCE_HITS = 3;
const PAPER_WINDOW_MS = 2600;
const PAPER_MIN_PACKETS = 28;
const PAPER_MAX_PACKETS = 96;
const PAPER_SEGMENTS = 8;
const PAPER_GUARD_BINS = 1;
const PAPER_NMI_BINS = 10;
const REMOTE_RELAY_URL = getRemoteRelayUrl();
const REMOTE_PUBLISH_MIN_MS = 500;

const SCORE_FEATURES = [
  { name: "temporalStd", mode: "increase", weight: 0.3 },
  { name: "deltaMean", mode: "increase", weight: 0.24 },
  { name: "corrDrop", mode: "increase", weight: 0.18 },
  { name: "shapeShift", mode: "increase", weight: 0.18 },
  { name: "rssiStd", mode: "increase", weight: 0.05 },
  { name: "ampStd", mode: "increase", weight: 0.05 },
];

const PAPER_SCORE_FEATURES = [
  { name: "nonzeroDopplerEnergy", mode: "increase", weight: 0.46 },
  { name: "selectedNonzeroDopplerEnergy", mode: "increase", weight: 0.3 },
  { name: "dopplerActivityRatio", mode: "increase", weight: 0.24 },
];

const state = {
  phase: "idle",
  port: null,
  reader: null,
  readerActive: false,
  readPromise: null,
  tickTimer: null,
  lineBuffer: "",
  packets: [],
  baselinePackets: [],
  baseline: null,
  prepStartedAt: 0,
  baselineStartedAt: 0,
  totalPackets: 0,
  latestResult: null,
  history: [],
  currentMotionStartAt: 0,
  lastMotionRowAt: 0,
  motionRows: [],
  lastRemotePublishAt: 0,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  renderIdle();
});

function cacheElements() {
  [
    "mainButton",
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
}

function bindEvents() {
  els.mainButton.addEventListener("click", () => {
    if (state.phase === "idle" || state.phase === "error") {
      startMonitoring();
    } else {
      stopMonitoring();
    }
  });
}

async function startMonitoring() {
  if (!("serial" in navigator)) {
    setError("当前环境不支持网页串口。手机端 Chrome/Safari 通常不能直接连接 ESP32；请在电脑端 Chrome 或 Edge 打开此页并通过 USB 连接接收端。若要手机查看结果，需要让 Mac 作为采集服务器转发数据。");
    return;
  }

  resetRun();
  setBusy(true, "正在连接接收端...");

  try {
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: BAUD_RATE, bufferSize: 65536 });
    state.readerActive = true;
    state.readPromise = readSerialLoop();
    state.phase = "preparing";
    state.prepStartedAt = nowMs();
    state.baselineStartedAt = 0;
    state.tickTimer = window.setInterval(tick, 250);
    setBusy(false);
    renderPreparing();
  } catch (error) {
    setBusy(false);
    if (error?.name === "NotFoundError") {
      setError("没有选择串口。需要选择 ESP32-C5 接收端后才能监测。");
    } else {
      setError(`连接失败：${error?.message || error}`);
    }
    await closeSerial();
  }
}

async function stopMonitoring() {
  const wasRunning = state.phase !== "idle";
  state.phase = "idle";
  if (state.tickTimer) {
    window.clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
  await closeSerial();
  if (wasRunning) {
    renderIdle("监测已停止。点击开始监测可重新建立电磁环境投影。");
  } else {
    renderIdle();
  }
}

async function closeSerial() {
  state.readerActive = false;
  if (state.reader) {
    try {
      await state.reader.cancel();
    } catch (_error) {
      // Closing the port also interrupts the reader in some browsers.
    }
  }
  if (state.readPromise) {
    try {
      await state.readPromise;
    } catch (_error) {
      // The read loop reports active errors through the UI.
    }
    state.readPromise = null;
  }
  if (state.port) {
    try {
      await state.port.close();
    } catch (_error) {
      // Ignore close races after reader cancellation.
    }
    state.port = null;
  }
  state.reader = null;
  setSerialStatus("串口未连接", "");
}

async function readSerialLoop() {
  const decoder = new TextDecoder();

  try {
    while (state.readerActive && state.port?.readable) {
      state.reader = state.port.readable.getReader();
      try {
        while (state.readerActive) {
          const { value, done } = await state.reader.read();
          if (done) break;
          if (value) processSerialText(decoder.decode(value, { stream: true }));
        }
      } finally {
        state.reader.releaseLock();
        state.reader = null;
      }
    }
  } catch (error) {
    if (state.readerActive) {
      setError(`串口读取失败：${error?.message || error}`);
    }
  }
}

function processSerialText(text) {
  state.lineBuffer += text;
  const lines = state.lineBuffer.split(/\r?\n/);
  state.lineBuffer = lines.pop() || "";
  lines.forEach(processSerialLine);
}

function processSerialLine(line) {
  if (state.phase === "idle" || state.phase === "error") return;
  const packet = parseCsiLine(line);
  if (!packet) return;

  state.totalPackets += 1;
  state.packets.push(packet);

  const cutoff = nowMs() - RETAIN_MS;
  while (state.packets.length && state.packets[0].time < cutoff) {
    state.packets.shift();
  }

  if (state.phase === "baseline") {
    state.baselinePackets.push(packet);
  }
}

function tick() {
  if (state.phase === "preparing") {
    const elapsed = nowMs() - state.prepStartedAt;
    if (elapsed >= PREPARE_MS) {
      state.phase = "baseline";
      state.baselineStartedAt = nowMs();
      state.baselinePackets = [];
      renderBaseline();
      return;
    }
    renderPreparing();
    return;
  }

  if (state.phase === "baseline") {
    const elapsed = nowMs() - state.baselineStartedAt;
    if (elapsed >= BASELINE_MS && state.baselinePackets.length >= MIN_BASELINE_PACKETS) {
      const baseline = buildBaseline(state.baselinePackets);
      if (baseline) {
        state.baseline = baseline;
        state.phase = "monitoring";
        state.history = [];
        renderMonitoring({
          score: 0,
          threshold: baseline.threshold,
          present: false,
          artifactReason: "",
          text: "电磁环境投影已建立，正在实时监测 CSI 动态变化。",
        });
        return;
      }
    }
    renderBaseline();
    return;
  }

  if (state.phase === "monitoring") {
    const result = evaluateCurrentWindow();
    renderMonitoring(result);
  }
}

function buildBaseline(packets) {
  const baselineShape = computeMeanShape(packets);
  if (!baselineShape) return null;

  const windows = makeWindows(packets, WINDOW_MS, STEP_MS)
    .map((windowPackets) => computeWindowFeatures(windowPackets, baselineShape))
    .filter(Boolean);

  if (windows.length < 4) return null;

  const names = [
    "ampMean",
    "ampStd",
    "temporalStd",
    "deltaMean",
    "corrDrop",
    "shapeShift",
    "rssiMean",
    "rssiStd",
    "fftGainMean",
    "agcGainMean",
  ];

  const stats = {};
  names.forEach((name) => {
    stats[name] = robustStats(windows.map((row) => row[name]).filter(Number.isFinite));
  });

  const baseline = {
    shape: baselineShape,
    stats,
    channelMode: modeNumber(windows.map((row) => row.channelMode)),
    paper: null,
    threshold: 55,
  };

  const baselineScores = windows.map((features) => scoreWindow(features, baseline).score);
  baseline.threshold = clamp(percentile(baselineScores, 95) + 18, 45, 72);
  baseline.paper = buildPaperBaseline(packets);
  return baseline;
}

function evaluateCurrentWindow() {
  const now = nowMs();
  const windowPackets = state.packets.filter((packet) => now - packet.time <= WINDOW_MS);

  if (!state.baseline || windowPackets.length < MIN_WINDOW_PACKETS) {
    return {
      score: 0,
      threshold: state.baseline?.threshold || 55,
      present: false,
      changeScore: 0,
      changeThreshold: state.baseline?.threshold || 55,
      changeHit: false,
      paperScore: 0,
      paperThreshold: state.baseline?.paper?.threshold || 60,
      paperHit: false,
      artifactReason: "数据不足",
      text: "正在等待实时 CSI 数据。",
    };
  }

  const features = computeWindowFeatures(windowPackets, state.baseline.shape);
  if (!features) {
    return {
      score: 0,
      threshold: state.baseline.threshold,
      present: false,
      changeScore: 0,
      changeThreshold: state.baseline.threshold,
      changeHit: false,
      paperScore: 0,
      paperThreshold: state.baseline.paper?.threshold || 60,
      paperHit: false,
      artifactReason: "数据不足",
      text: "正在等待实时 CSI 数据。",
    };
  }

  const scored = scoreWindow(features, state.baseline);
  const paper = evaluatePaperActivity(now);
  const changeHit = scored.score >= state.baseline.threshold && !scored.artifactReason;
  const paperHit = paper.available && paper.score >= paper.threshold;
  const humanHit = changeHit || paperHit;
  const displayScore = Math.round(clamp(0.42 * scored.score + 0.58 * paper.score, 0, 100));

  state.history.push({ time: now, hit: humanHit, score: displayScore });
  state.history = state.history.filter((item) => now - item.time <= PERSISTENCE_MS);

  const hits = state.history.filter((item) => item.hit).length;
  const present = hits >= PERSISTENCE_HITS;
  const text = buildResultText(scored, paper, changeHit, paperHit, present);
  const result = {
    ...scored,
    paper,
    changeScore: scored.score,
    changeThreshold: scored.threshold,
    paperScore: paper.score,
    paperThreshold: paper.threshold,
    changeHit,
    paperHit,
    score: displayScore,
    present,
    text,
  };
  state.latestResult = result;
  window.csiDetectorState = {
    phase: state.phase,
    changeScore: scored.score,
    changeThreshold: scored.threshold,
    paperScore: paper.score,
    paperThreshold: paper.threshold,
    changeHit,
    paperHit,
    present,
    artifactReason: scored.artifactReason,
  };
  return result;
}

function scoreWindow(features, baseline) {
  const z = {};
  let score = 0;

  SCORE_FEATURES.forEach((feature) => {
    const value = features[feature.name];
    const featureZ = robustZ(value, baseline.stats[feature.name], feature.mode);
    z[feature.name] = featureZ;
    score += feature.weight * zToScore(featureZ);
  });

  z.ampMean = robustZ(features.ampMean, baseline.stats.ampMean, "abs");
  z.rssiMean = robustZ(features.rssiMean, baseline.stats.rssiMean, "abs");
  z.fftGainMean = robustZ(features.fftGainMean, baseline.stats.fftGainMean, "abs");
  z.agcGainMean = robustZ(features.agcGainMean, baseline.stats.agcGainMean, "abs");

  let artifactReason = "";
  const channelChanged = Number.isFinite(baseline.channelMode) && features.channelMode !== baseline.channelMode;
  const gainChanged = z.fftGainMean > 6 || z.agcGainMean > 6;
  const globalOnly =
    (z.ampMean > 8 || z.rssiMean > 7) &&
    z.temporalStd < 2.4 &&
    z.deltaMean < 2.4 &&
    z.corrDrop < 2.4 &&
    z.shapeShift < 2.6;

  if (features.packetCount < MIN_WINDOW_PACKETS) {
    artifactReason = "数据不足";
  } else if (channelChanged) {
    artifactReason = "信道变化";
  } else if (gainChanged && score < 58) {
    artifactReason = "硬件增益变化";
  } else if (globalOnly) {
    artifactReason = "短时整体幅度变化";
  }

  if (artifactReason) {
    score = Math.min(score, 42);
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    threshold: baseline.threshold,
    artifactReason,
    features,
    z,
  };
}

function buildResultText(result, paper, changeHit, paperHit, present) {
  if (present) {
    if (changeHit && paperHit) {
      return "环境变化层和 Doppler/NMI 层均连续触发，判定为有人活动。";
    }
    if (paperHit) {
      return "Doppler/NMI 层连续触发，判定为有人活动。";
    }
    return "鲁棒 CSI 投影门控连续触发，判定为有人活动。";
  }
  if (result.artifactReason) {
    return `${result.artifactReason}，暂不判定为人体活动。`;
  }
  if (changeHit || paperHit) {
    return "已有一层疑似人体活动，正在等待连续确认。";
  }
  if (!paper.available) {
    return "正在积累 Doppler/NMI 二次判断所需的 CSI 数据。";
  }
  return "CSI 动态特征接近当前电磁环境投影，未发现持续人体活动。";
}

function buildPaperBaseline(packets) {
  const windows = makeWindows(packets, PAPER_WINDOW_MS, STEP_MS)
    .map((windowPackets) => computePaperFeatures(windowPackets))
    .filter(Boolean);

  if (windows.length < 3) {
    return {
      available: false,
      threshold: 60,
      stats: {},
    };
  }

  const stats = {};
  PAPER_SCORE_FEATURES.forEach((feature) => {
    stats[feature.name] = robustStats(windows.map((row) => row[feature.name]));
  });

  const paperBaseline = {
    available: true,
    threshold: 60,
    stats,
  };
  const scores = windows.map((features) => scorePaperFeatures(features, paperBaseline).score);
  paperBaseline.threshold = clamp(percentile(scores, 95) + 18, 48, 74);
  return paperBaseline;
}

function evaluatePaperActivity(now) {
  const emptyResult = {
    available: false,
    score: 0,
    threshold: state.baseline?.paper?.threshold || 60,
    features: null,
  };

  if (!state.baseline?.paper?.available) return emptyResult;

  const packets = state.packets.filter((packet) => now - packet.time <= PAPER_WINDOW_MS);
  const features = computePaperFeatures(packets);
  if (!features) return emptyResult;

  return {
    ...scorePaperFeatures(features, state.baseline.paper),
    available: true,
    features,
  };
}

function scorePaperFeatures(features, paperBaseline) {
  let score = 0;
  const z = {};

  PAPER_SCORE_FEATURES.forEach((feature) => {
    const featureZ = robustZ(features[feature.name], paperBaseline.stats[feature.name], feature.mode);
    z[feature.name] = featureZ;
    score += feature.weight * zToScore(featureZ);
  });

  return {
    score: Math.round(clamp(score, 0, 100)),
    threshold: paperBaseline.threshold,
    z,
  };
}

function computePaperFeatures(packets) {
  const sampled = downsamplePackets(
    packets.filter((packet) => packet.amps.length >= 24),
    PAPER_MAX_PACKETS,
  );
  if (sampled.length < PAPER_MIN_PACKETS) return null;

  const minLen = Math.min(...sampled.map((packet) => packet.amps.length));
  if (minLen < 24) return null;

  const segments = makeSegments(minLen, PAPER_SEGMENTS);
  const segmentSeries = sampled.map((packet) => {
    const vector = packet.amps.slice(0, minLen);
    const scale = mean(vector) || 1;
    const normalized = vector.map((value) => value / scale);
    return segments.map(([start, end]) => mean(normalized.slice(start, end)));
  });

  const { power, bins } = dftPowerBySegment(segmentSeries);
  if (!power.length) return null;

  const segmentCount = segments.length;
  const segmentVectors = Array.from({ length: segmentCount }, () => []);
  const segmentEnergies = Array(segmentCount).fill(0);
  let nonzeroTotal = 0;
  let nonzeroBins = 0;
  let zeroTotal = 0;
  let zeroBins = 0;

  for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
    const isNonzero = Math.abs(bins[binIndex]) > PAPER_GUARD_BINS;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const value = power[binIndex][segmentIndex];
      if (isNonzero) {
        segmentVectors[segmentIndex].push(value);
        segmentEnergies[segmentIndex] += value;
        nonzeroTotal += value;
      } else {
        zeroTotal += value;
      }
    }
    if (isNonzero) {
      nonzeroBins += segmentCount;
    } else {
      zeroBins += segmentCount;
    }
  }

  const dynamicSide = selectDynamicSegments(segmentVectors, segmentEnergies);
  const selectedTotal = dynamicSide.reduce((sum, index) => sum + segmentEnergies[index], 0);
  const selectedBins = Math.max(1, dynamicSide.length * Math.max(1, segmentVectors[0]?.length || 1));
  const nonzeroMean = nonzeroTotal / Math.max(1, nonzeroBins);
  const zeroMean = zeroTotal / Math.max(1, zeroBins);

  return {
    nonzeroDopplerEnergy: nonzeroMean,
    selectedNonzeroDopplerEnergy: selectedTotal / selectedBins,
    dopplerActivityRatio: nonzeroMean / Math.max(zeroMean, 1e-9),
    selectedSegments: dynamicSide.map((index) => `S${index + 1}`).join(" "),
  };
}

function downsamplePackets(packets, maxPackets) {
  if (packets.length <= maxPackets) return packets;
  const sampled = [];
  const step = (packets.length - 1) / (maxPackets - 1);
  for (let index = 0; index < maxPackets; index += 1) {
    sampled.push(packets[Math.round(index * step)]);
  }
  return sampled;
}

function makeSegments(count, segmentCount) {
  const width = Math.min(count, Math.max(4, Math.ceil((count / Math.max(1, segmentCount - 1)) * 1.25)));
  const stride = Math.max(1, Math.floor((count - width) / Math.max(1, segmentCount - 1)));
  return Array.from({ length: segmentCount }, (_, index) => {
    const start = Math.min(index * stride, count - width);
    return [start, Math.min(count, start + width)];
  });
}

function dftPowerBySegment(segmentSeries) {
  const sampleCount = segmentSeries.length;
  const segmentCount = segmentSeries[0]?.length || 0;
  if (sampleCount < 2 || !segmentCount) return { power: [], bins: [] };

  const fftSize = Math.max(32, nextPowerOfTwo(sampleCount));
  const means = Array.from({ length: segmentCount }, (_, segmentIndex) =>
    mean(segmentSeries.map((row) => row[segmentIndex])),
  );
  const power = [];
  const bins = [];

  for (let shifted = -Math.floor(fftSize / 2); shifted < Math.ceil(fftSize / 2); shifted += 1) {
    const rawBin = (shifted + fftSize) % fftSize;
    const rowPower = [];
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      let real = 0;
      let imag = 0;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const windowValue = hann(sampleIndex, sampleCount);
        const value = (segmentSeries[sampleIndex][segmentIndex] - means[segmentIndex]) * windowValue;
        const angle = (-2 * Math.PI * rawBin * sampleIndex) / fftSize;
        real += value * Math.cos(angle);
        imag += value * Math.sin(angle);
      }
      rowPower.push((real * real + imag * imag) / sampleCount);
    }
    bins.push(shifted);
    power.push(rowPower);
  }

  return { power, bins };
}

function selectDynamicSegments(segmentVectors, segmentEnergies) {
  const nmi = nmiMatrix(segmentVectors, PAPER_NMI_BINS);
  const nodeCount = segmentVectors.length;
  const half = Math.floor(nodeCount / 2);
  const constant = Math.max(...nmi.flat(), 0) + 1e-6;
  let best = [0, 1, 2, 3].slice(0, half);
  let bestScore = -Infinity;

  combinations(
    Array.from({ length: nodeCount - 1 }, (_, index) => index + 1),
    half - 1,
  ).forEach((combo) => {
    const side = [0, ...combo];
    const sideSet = new Set(side);
    let score = 0;
    for (let i = 0; i < nodeCount; i += 1) {
      for (let j = i + 1; j < nodeCount; j += 1) {
        if (sideSet.has(i) !== sideSet.has(j)) {
          score += constant - nmi[i][j];
        }
      }
    }
    if (score > bestScore) {
      best = side;
      bestScore = score;
    }
  });

  const bestSet = new Set(best);
  const other = Array.from({ length: nodeCount }, (_, index) => index).filter((index) => !bestSet.has(index));
  const bestEnergy = best.reduce((sum, index) => sum + segmentEnergies[index], 0);
  const otherEnergy = other.reduce((sum, index) => sum + segmentEnergies[index], 0);
  return bestEnergy >= otherEnergy ? best : other;
}

function nmiMatrix(vectors, bins) {
  const count = vectors.length;
  const matrix = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => (row === col ? 1 : 0)),
  );
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const value = normalizedMutualInformation(vectors[i], vectors[j], bins);
      matrix[i][j] = value;
      matrix[j][i] = value;
    }
  }
  return matrix;
}

function normalizedMutualInformation(a, b, bins) {
  const len = Math.min(a.length, b.length);
  if (len < 4 || std(a) < 1e-12 || std(b) < 1e-12) return 0;

  const x = a.slice(0, len);
  const y = b.slice(0, len);
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const yMin = Math.min(...y);
  const yMax = Math.max(...y);
  if (xMax === xMin || yMax === yMin) return 0;

  const histX = Array(bins).fill(0);
  const histY = Array(bins).fill(0);
  const histXY = Array.from({ length: bins }, () => Array(bins).fill(0));

  for (let index = 0; index < len; index += 1) {
    const xi = clamp(Math.floor(((x[index] - xMin) / (xMax - xMin)) * bins), 0, bins - 1);
    const yi = clamp(Math.floor(((y[index] - yMin) / (yMax - yMin)) * bins), 0, bins - 1);
    histX[xi] += 1;
    histY[yi] += 1;
    histXY[xi][yi] += 1;
  }

  const hx = entropy(histX);
  const hy = entropy(histY);
  const hxy = entropy(histXY.flat());
  const denom = hx + hy;
  if (denom <= 1e-12) return 0;
  return clamp((2 * (hx + hy - hxy)) / denom, 0, 1);
}

function entropy(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  return counts.reduce((sum, count) => {
    if (count <= 0) return sum;
    const probability = count / total;
    return sum - probability * Math.log(probability);
  }, 0);
}

function combinations(items, choose) {
  if (choose <= 0) return [[]];
  if (choose > items.length) return [];
  const output = [];
  const visit = (start, combo) => {
    if (combo.length === choose) {
      output.push([...combo]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      combo.push(items[index]);
      visit(index + 1, combo);
      combo.pop();
    }
  };
  visit(0, []);
  return output;
}

function hann(index, length) {
  if (length <= 1) return 1;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
}

function nextPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(2, value)));
}

function computeWindowFeatures(packets, baselineShape) {
  const usable = packets.filter((packet) => packet.amps.length >= 24);
  if (usable.length < MIN_WINDOW_PACKETS) return null;

  const minLen = Math.min(
    baselineShape?.length || Infinity,
    ...usable.map((packet) => packet.amps.length),
  );
  if (!Number.isFinite(minLen) || minLen < 24) return null;

  const vectors = usable.map((packet) => packet.amps.slice(0, minLen));
  const packetMeans = vectors.map((vector) => mean(vector));
  const normVectors = vectors.map((vector, index) => {
    const scale = packetMeans[index] || 1;
    return vector.map((value) => value / scale);
  });

  const meanVector = Array.from({ length: minLen }, (_, index) => mean(vectors.map((vector) => vector[index])));
  const meanVectorScale = mean(meanVector) || 1;
  const shapeVector = meanVector.map((value) => value / meanVectorScale);

  let temporalStd = 0;
  for (let index = 0; index < minLen; index += 1) {
    temporalStd += std(normVectors.map((vector) => vector[index]));
  }
  temporalStd /= minLen;

  let deltaMean = 0;
  let corrDrop = 0;
  for (let index = 1; index < normVectors.length; index += 1) {
    deltaMean += meanAbsDiff(normVectors[index], normVectors[index - 1]);
    corrDrop += 1 - clamp(correlation(normVectors[index], normVectors[index - 1]), -1, 1);
  }
  deltaMean /= Math.max(1, normVectors.length - 1);
  corrDrop /= Math.max(1, normVectors.length - 1);

  const rssiValues = usable.map((packet) => packet.rssi).filter(Number.isFinite);
  const fftGainValues = usable.map((packet) => packet.fftGain).filter(Number.isFinite);
  const agcGainValues = usable.map((packet) => packet.agcGain).filter(Number.isFinite);
  const shapeShift = baselineShape ? meanAbsDiff(shapeVector, baselineShape.slice(0, minLen)) : 0;

  return {
    packetCount: usable.length,
    ampMean: mean(packetMeans),
    ampStd: std(packetMeans),
    temporalStd,
    deltaMean,
    corrDrop,
    shapeShift,
    rssiMean: mean(rssiValues),
    rssiStd: std(rssiValues),
    fftGainMean: mean(fftGainValues),
    agcGainMean: mean(agcGainValues),
    channelMode: modeNumber(usable.map((packet) => packet.channel)),
  };
}

function computeMeanShape(packets) {
  const usable = packets.filter((packet) => packet.amps.length >= 24);
  if (usable.length < MIN_WINDOW_PACKETS) return null;
  const minLen = Math.min(...usable.map((packet) => packet.amps.length));
  const sums = Array(minLen).fill(0);
  let count = 0;

  usable.forEach((packet) => {
    const vector = packet.amps.slice(0, minLen);
    const scale = mean(vector) || 1;
    vector.forEach((value, index) => {
      sums[index] += value / scale;
    });
    count += 1;
  });

  return sums.map((value) => value / count);
}

function makeWindows(packets, windowMs, stepMs) {
  if (packets.length < MIN_WINDOW_PACKETS) return [];
  const sorted = [...packets].sort((a, b) => a.time - b.time);
  const start = sorted[0].time + windowMs;
  const end = sorted[sorted.length - 1].time;
  const windows = [];

  for (let right = start; right <= end; right += stepMs) {
    const left = right - windowMs;
    const windowPackets = sorted.filter((packet) => packet.time > left && packet.time <= right);
    if (windowPackets.length >= MIN_WINDOW_PACKETS) windows.push(windowPackets);
  }

  return windows;
}

function parseCsiLine(line) {
  const start = line.indexOf("CSI_DATA");
  if (start < 0) return null;

  const raw = line.slice(start).trim();
  const arrayMatch = raw.match(/\[([^\]]+)\]/);
  if (!arrayMatch) return null;

  const prefix = raw.slice(0, arrayMatch.index).replace(/,+\s*"?$/, "");
  const fields = prefix.split(",").map((field) => field.replace(/^"+|"+$/g, "").trim());
  if (fields[0] !== "CSI_DATA") return null;

  const values = arrayMatch[1]
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);

  const amps = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    const imag = values[index];
    const real = values[index + 1];
    if (imag === 0 && real === 0) continue;
    amps.push(Math.hypot(real, imag));
  }

  if (amps.length < 24) return null;

  return {
    time: nowMs(),
    rssi: numberOrNaN(fields[3]),
    rate: numberOrNaN(fields[4]),
    noiseFloor: numberOrNaN(fields[5]),
    fftGain: numberOrNaN(fields[6]),
    agcGain: numberOrNaN(fields[7]),
    channel: numberOrNaN(fields[8]),
    amps,
  };
}

function renderIdle(message = "点击开始监测。先给 5 秒准备时间，随后 10 秒保持空场稳定并建立电磁环境投影。") {
  setStateLabel("未开始", "idle");
  els.presenceText.textContent = message;
  els.presenceScore.textContent = "0";
  els.scoreFill.style.width = "0%";
  els.calibStatus.textContent = "未建立";
  els.packetCount.textContent = String(state.totalPackets || 0);
  els.rssiValue.textContent = "--";
  els.ampShift.textContent = "0.00";
  els.mainButton.textContent = "开始监测";
  els.mainButton.classList.remove("stop");
  els.mainButton.disabled = false;
  renderLayerCardsIdle();
  renderMotionIdle();
  publishRemoteState({ force: true });
}

function renderPreparing() {
  const elapsed = Math.max(0, nowMs() - state.prepStartedAt);
  const remain = Math.max(0, Math.ceil((PREPARE_MS - elapsed) / 1000));
  setStateLabel("准备空场", "baseline");
  setSerialStatus("串口已连接", "ok");
  els.presenceText.textContent = `准备倒计时 ${remain} 秒。请离开链路附近或保持空场，倒计时结束后自动采集 10 秒空场投影。`;
  els.presenceScore.textContent = "0";
  els.scoreFill.style.width = "0%";
  els.calibStatus.textContent = `准备 ${Math.min(5, Math.floor(elapsed / 1000))}/5 秒`;
  els.packetCount.textContent = String(state.totalPackets);
  renderLatestPacket();
  renderLayerCardsPreparing(remain);
  renderMotionPreparing(remain);
  setRunningButton();
  publishRemoteState();
}

function renderBaseline() {
  const elapsed = Math.max(0, nowMs() - state.baselineStartedAt);
  const remain = Math.max(0, Math.ceil((BASELINE_MS - elapsed) / 1000));
  setStateLabel("投影建模", "baseline");
  setSerialStatus("串口已连接", "ok");
  els.presenceText.textContent =
    remain > 0
      ? `正在建立电磁环境投影，还剩 ${remain} 秒。此时尽量不要走动。`
      : "投影样本不足，继续等待 CSI 数据。";
  els.presenceScore.textContent = "0";
  els.scoreFill.style.width = "0%";
  els.calibStatus.textContent = `${Math.min(10, Math.floor(elapsed / 1000))}/10 秒`;
  els.packetCount.textContent = String(state.totalPackets);
  renderLatestPacket();
  renderLayerCardsBaseline(remain);
  renderMotionBaseline(remain);
  setRunningButton();
  publishRemoteState();
}

function renderMonitoring(result) {
  const safeResult = result || { score: 0, present: false, text: "正在实时监测。" };
  const motionScale = computeMotionScale(safeResult);
  const motionActive = isMotionActive(safeResult, motionScale);
  setStateLabel(motionLevelText(motionScale, motionActive), motionStateClass(motionScale, motionActive));
  els.presenceText.textContent = safeResult.text;
  els.presenceScore.textContent = String(safeResult.score || 0);
  els.scoreFill.style.width = `${clamp(safeResult.score || 0, 0, 100)}%`;
  els.calibStatus.textContent = `投影已建立 阈值 ${Math.round(state.baseline?.threshold || 0)}`;
  els.packetCount.textContent = String(state.totalPackets);
  renderLatestPacket(safeResult);
  renderLayerCardsMonitoring(safeResult);
  renderMotionTimeline(safeResult);
  setSerialStatus("串口已连接", "ok");
  setRunningButton();
  publishRemoteState();
}

function renderLatestPacket(result = state.latestResult) {
  const latest = state.packets[state.packets.length - 1];
  els.rssiValue.textContent = latest && Number.isFinite(latest.rssi) ? `${latest.rssi} dBm` : "--";
  const ampShift = result?.z?.ampMean || 0;
  els.ampShift.textContent = ampShift.toFixed(2);
}

function renderMotionIdle() {
  state.currentMotionStartAt = 0;
  setMotionPanel(0, "等待数据", "持续时间 0.0 秒", false);
  renderMotionRows();
}

function renderMotionBaseline(remain) {
  setMotionPanel(0, "投影建模", `投影剩余 ${remain} 秒`, false);
}

function renderMotionPreparing(remain) {
  setMotionPanel(0, "准备空场", `准备倒计时 ${remain} 秒`, false);
}

function renderMotionTimeline(result) {
  const now = nowMs();
  const scale = computeMotionScale(result);
  const active = isMotionActive(result, scale);

  if (active && !state.currentMotionStartAt) {
    state.currentMotionStartAt = now;
  } else if (!active) {
    state.currentMotionStartAt = 0;
  }

  const durationMs = state.currentMotionStartAt ? now - state.currentMotionStartAt : 0;
  const level = motionLevelText(scale, active);
  const trigger = motionTriggerText(result, scale);
  setMotionPanel(scale, level, `持续时间 ${formatDuration(durationMs)}`, active);

  if (active && now - state.lastMotionRowAt >= 1000) {
    state.lastMotionRowAt = now;
    state.motionRows.unshift({
      time: formatClock(now),
      label: level,
      scale,
      duration: formatDuration(durationMs),
      trigger,
    });
    state.motionRows = state.motionRows.slice(0, 7);
    renderMotionRows();
  }
}

function computeMotionScale(result) {
  const combined = Number(result?.score || 0);
  const change = Number(result?.changeScore ?? result?.score ?? 0);
  const paper = Number(result?.paperScore ?? result?.paper?.score ?? 0);
  let scale = 0.42 * combined + 0.32 * change + 0.26 * paper;
  if (result?.artifactReason && result.artifactReason !== "数据不足") {
    scale = Math.min(scale, 35);
  }
  return Math.round(clamp(scale, 0, 100));
}

function isMotionActive(result, scale) {
  return Boolean(result?.present || result?.changeHit || result?.paperHit || scale >= 45);
}

function motionLevelText(scale, active) {
  if (!active && scale < 25) return "静稳环境";
  if (scale >= 75) return "强活动";
  if (scale >= 50) return "中等活动";
  if (scale >= 30) return "微动作";
  return "候选波动";
}

function motionStateClass(scale, active) {
  if (!active && scale < 25) return "stable";
  if (scale >= 75) return "strong";
  if (scale >= 50) return "medium";
  if (scale >= 30) return "weak";
  return "candidate";
}

function motionTriggerText(result, scale) {
  if (result?.present) return "融合判定";
  if (result?.changeHit && result?.paperHit) return "双门控";
  if (result?.paperHit) return "Doppler-NMI";
  if (result?.changeHit) return "CSI 投影";
  if (result?.artifactReason && result.artifactReason !== "数据不足") return "伪迹过滤";
  if (scale >= 45) return "候选波动";
  return "稳定";
}

function setMotionPanel(scale, level, durationText, active) {
  if (!els.motionOrb) return;
  els.motionOrb.style.setProperty("--motion-scale", String(clamp(scale, 0, 100)));
  els.motionOrb.classList.toggle("active", active);
  els.motionScale.textContent = String(Math.round(scale));
  els.motionLevel.textContent = level;
  els.motionDuration.textContent = durationText;
}

function renderMotionRows() {
  if (!els.motionTimelineBody) return;
  if (!state.motionRows.length) {
    els.motionTimelineBody.innerHTML = '<tr><td colspan="4">有动作时自动记录</td></tr>';
    return;
  }
  els.motionTimelineBody.innerHTML = state.motionRows
    .map(
      (row) =>
        `<tr><td>${row.time}</td><td class="scale-cell"><strong>${row.label || "候选波动"}</strong><small>${row.scale}/100</small></td><td>${row.duration}</td><td>${row.trigger}</td></tr>`,
    )
    .join("");
}

function formatClock(timeMs) {
  return new Date(timeMs).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(durationMs) {
  const seconds = Math.max(0, durationMs / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}

function renderLayerCardsIdle() {
  setLayerCard("change", "idle", "未开始", "归一化 CSI 形态漂移检测", 0, "--");
  setLayerCard("paper", "idle", "未开始", "Doppler-NMI 动态分段确认", 0, "--");
  setLayerCard("combined", "idle", "未开始", "双门控 OR 融合与时间持续性判决", 0, "连续确认");
}

function renderLayerCardsBaseline(remain) {
  const text = remain > 0 ? `还剩 ${remain} 秒` : "等待更多 CSI 数据";
  setLayerCard("change", "wait", "投影建模", text, 0, "--");
  setLayerCard("paper", "wait", "投影建模", text, 0, "--");
  setLayerCard("combined", "wait", "等待判决", "投影完成后启动融合判决", 0, "连续确认");
}

function renderLayerCardsPreparing(remain) {
  const text = `准备倒计时 ${remain} 秒`;
  setLayerCard("change", "wait", "准备空场", "暂不写入投影样本", 0, "--");
  setLayerCard("paper", "wait", "等待预热", text, 0, "--");
  setLayerCard("combined", "wait", "尚未判决", "5 秒后自动进入 10 秒投影采样", 0, "连续确认");
}

function renderLayerCardsMonitoring(result) {
  const changeScore = Math.round(result.changeScore ?? 0);
  const changeThreshold = Math.round(result.changeThreshold ?? state.baseline?.threshold ?? 0);
  const paperScore = Math.round(result.paperScore ?? result.paper?.score ?? 0);
  const paperThreshold = Math.round(result.paperThreshold ?? result.paper?.threshold ?? state.baseline?.paper?.threshold ?? 0);
  const combinedScore = Math.round(result.score ?? 0);
  const paperAvailable = result.paper?.available ?? Boolean(state.baseline?.paper?.available);

  if (result.changeHit) {
    setLayerCard("change", "hit", "门控触发", "归一化 CSI 动态连续偏离投影", changeScore, changeThreshold);
  } else if (result.artifactReason && result.artifactReason !== "数据不足") {
    setLayerCard("change", "wait", "已过滤", result.artifactReason, changeScore, changeThreshold);
  } else if (result.artifactReason === "数据不足") {
    setLayerCard("change", "wait", "等待数据", "实时窗口 CSI 数据不足", changeScore, changeThreshold);
  } else {
    setLayerCard("change", "clear", "投影一致", "CSI 形态接近电磁环境投影", changeScore, changeThreshold);
  }

  if (!paperAvailable) {
    setLayerCard("paper", "wait", "等待数据", "Doppler/NMI 需要更长窗口", paperScore, paperThreshold || "--");
  } else if (result.paperHit) {
    setLayerCard("paper", "hit", "触发", "检测到非零 Doppler 活动", paperScore, paperThreshold);
  } else {
    setLayerCard("paper", "clear", "未触发", "未发现持续 Doppler 活动", paperScore, paperThreshold);
  }

  if (result.present) {
    setLayerCard("combined", "hit", "有人活动", "任一门控连续触发后提醒", combinedScore, "连续确认");
  } else if (result.changeHit || result.paperHit) {
    setLayerCard("combined", "wait", "等待确认", "已有单层触发，继续观察", combinedScore, "连续确认");
  } else {
    setLayerCard("combined", "clear", "无人活动", "两层均未连续触发", combinedScore, "连续确认");
  }
}

function setLayerCard(prefix, className, status, text, score, threshold) {
  const card = els[`${prefix}Card`];
  if (!card) return;
  card.className = `alert-card ${className}`;
  els[`${prefix}Status`].textContent = status;
  els[`${prefix}Text`].textContent = text;
  els[`${prefix}Score`].textContent = String(score);
  els[`${prefix}Threshold`].textContent = String(threshold);
}

function setRunningButton() {
  els.mainButton.disabled = false;
  els.mainButton.textContent = "停止监测";
  els.mainButton.classList.add("stop");
}

function setBusy(isBusy, text) {
  els.mainButton.disabled = isBusy;
  if (text) els.mainButton.textContent = text;
}

function setError(message) {
  state.phase = "error";
  setStateLabel("未开始", "idle");
  setSerialStatus("串口未连接", "");
  els.presenceText.textContent = message;
  els.calibStatus.textContent = "未建立";
  els.presenceScore.textContent = "0";
  els.scoreFill.style.width = "0%";
  els.mainButton.textContent = "开始监测";
  els.mainButton.classList.remove("stop");
  els.mainButton.disabled = false;
  renderLayerCardsIdle();
  renderMotionIdle();
  publishRemoteState({ force: true });
}

function setStateLabel(text, className) {
  els.presenceState.textContent = text;
  els.presenceState.className = `judgement ${className}`;
}

function setSerialStatus(text, className) {
  els.serialStatus.textContent = text;
  els.serialStatus.className = `status-pill ${className}`.trim();
}

function getRemoteRelayUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("relay");
    if (fromQuery) {
      localStorage.setItem("csiRemoteRelayUrl", fromQuery);
      return fromQuery;
    }
    return localStorage.getItem("csiRemoteRelayUrl") || "http://127.0.0.1:8091";
  } catch (_error) {
    return "http://127.0.0.1:8091";
  }
}

function publishRemoteState(options = {}) {
  if (!REMOTE_RELAY_URL) return;
  const now = nowMs();
  if (!options.force && now - state.lastRemotePublishAt < REMOTE_PUBLISH_MIN_MS) return;
  state.lastRemotePublishAt = now;

  const endpoint = `${REMOTE_RELAY_URL.replace(/\/$/, "")}/api/state`;
  sendRemotePayload(endpoint, buildRemoteStatePayload(now));
}

function sendRemotePayload(endpoint, payload) {
  const body = JSON.stringify(payload);
  if (typeof fetch === "function") {
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {
      // Remote display is optional; the detector must keep running even if the relay is closed.
    });
    return;
  }

  if (typeof XMLHttpRequest !== "undefined") {
    try {
      const request = new XMLHttpRequest();
      request.open("POST", endpoint, true);
      request.setRequestHeader("Content-Type", "application/json");
      request.send(body);
    } catch (_error) {
      // Remote display is optional; the detector must keep running even if the relay is closed.
    }
  }
}

function buildRemoteStatePayload(now) {
  const score = Number(els.presenceScore?.textContent || 0);
  return {
    phase: state.phase,
    source: "mac-browser",
    localTime: now,
    pageTitle: document.title,
    presenceLabel: els.presenceState?.textContent || "等待采集",
    present: Boolean(state.latestResult?.present),
    score: Number.isFinite(score) ? score : 0,
    text: els.presenceText?.textContent || "",
    serialStatus: els.serialStatus?.textContent || "串口未连接",
    packetCount: state.totalPackets,
    rssi: els.rssiValue?.textContent || "--",
    ampShift: els.ampShift?.textContent || "0.00",
    motionScale: els.motionScale?.textContent || "0",
    motionLevel: els.motionLevel?.textContent || "等待数据",
    motionDuration: els.motionDuration?.textContent || "持续时间 0.0 秒",
    change: buildRemoteLayerPayload("change"),
    paper: buildRemoteLayerPayload("paper"),
    combined: buildRemoteLayerPayload("combined"),
  };
}

function buildRemoteLayerPayload(prefix) {
  return {
    status: els[`${prefix}Status`]?.textContent || "待初始化",
    text: els[`${prefix}Text`]?.textContent || "",
    score: els[`${prefix}Score`]?.textContent || "0",
    threshold: els[`${prefix}Threshold`]?.textContent || "--",
  };
}

function resetRun() {
  state.phase = "idle";
  state.lineBuffer = "";
  state.packets = [];
  state.baselinePackets = [];
  state.baseline = null;
  state.prepStartedAt = 0;
  state.baselineStartedAt = 0;
  state.totalPackets = 0;
  state.latestResult = null;
  state.history = [];
  state.currentMotionStartAt = 0;
  state.lastMotionRowAt = 0;
  state.motionRows = [];
  state.lastRemotePublishAt = 0;
  if (state.tickTimer) {
    window.clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
}

function robustStats(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return { median: 0, spread: 1 };
  const med = median(clean);
  const deviations = clean.map((value) => Math.abs(value - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  const fallback = Math.max(Math.abs(med) * 0.04, 0.0005);
  return { median: med, spread: Math.max(mad * 1.4826, fallback) };
}

function robustZ(value, stats, mode) {
  if (!Number.isFinite(value) || !stats) return 0;
  const delta = mode === "increase" ? value - stats.median : Math.abs(value - stats.median);
  return Math.max(0, delta / stats.spread);
}

function zToScore(z) {
  return clamp((z - 1) / 5, 0, 1) * 100;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return NaN;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function std(values) {
  const avg = mean(values);
  if (!Number.isFinite(avg)) return 0;
  const clean = values.filter(Number.isFinite);
  const variance = clean.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, clean.length);
  return Math.sqrt(variance);
}

function median(sortedValues) {
  if (!sortedValues.length) return 0;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, percentage) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (percentage / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function meanAbsDiff(a, b) {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let total = 0;
  for (let index = 0; index < len; index += 1) {
    total += Math.abs(a[index] - b[index]);
  }
  return total / len;
}

function correlation(a, b) {
  const len = Math.min(a.length, b.length);
  if (!len) return 1;
  const aSlice = a.slice(0, len);
  const bSlice = b.slice(0, len);
  const aMean = mean(aSlice);
  const bMean = mean(bSlice);
  let numerator = 0;
  let aDenom = 0;
  let bDenom = 0;
  for (let index = 0; index < len; index += 1) {
    const ax = aSlice[index] - aMean;
    const bx = bSlice[index] - bMean;
    numerator += ax * bx;
    aDenom += ax * ax;
    bDenom += bx * bx;
  }
  const denom = Math.sqrt(aDenom * bDenom);
  return denom ? numerator / denom : 1;
}

function modeNumber(values) {
  const counts = new Map();
  values.filter(Number.isFinite).forEach((value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  let bestValue = NaN;
  let bestCount = -1;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });
  return bestValue;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberOrNaN(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function nowMs() {
  return performance.now();
}
