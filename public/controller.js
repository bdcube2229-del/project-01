const video = document.querySelector("#camera");
const analysisCanvas = document.querySelector("#analysisCanvas");
const analysis = analysisCanvas.getContext("2d", { willReadFrequently: true });
const overlayCanvas = document.querySelector("#overlayCanvas");
const overlay = overlayCanvas.getContext("2d");
const cameraStage = document.querySelector("#cameraStage");
const cameraEmpty = document.querySelector("#cameraEmpty");
const detectStatus = document.querySelector("#detectStatus");
const startCameraButton = document.querySelector("#startCamera");
const secureNotice = document.querySelector("#secureNotice");
const connectionChip = document.querySelector("#connectionChip");
const phoneX = document.querySelector("#phoneX");
const phoneY = document.querySelector("#phoneY");
const confidenceEl = document.querySelector("#confidence");
const photoInput = document.querySelector("#photoInput");
const simPad = document.querySelector("#simPad");
const simDot = document.querySelector("#simDot");

const deviceId = sessionStorage.getItem("phoneAimId") || crypto.randomUUID();
sessionStorage.setItem("phoneAimId", deviceId);

let stream = null;
let running = false;
let smoothAim = { x: 0.5, y: 0.5 };
let lastSent = 0;

const markerDefinitions = [
  { key: "tl", label: "TL", color: "#ff2f8b", matches: (h, s, v) => (h >= 325 || h <= 8) && s > 0.48 && v > 0.48 },
  { key: "tr", label: "TR", color: "#00d8ff", matches: (h, s, v) => h >= 174 && h <= 205 && s > 0.48 && v > 0.45 },
  { key: "br", label: "BR", color: "#ffe500", matches: (h, s, v) => h >= 44 && h <= 72 && s > 0.48 && v > 0.5 },
  { key: "bl", label: "BL", color: "#39ff88", matches: (h, s, v) => h >= 112 && h <= 158 && s > 0.42 && v > 0.45 },
];

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : delta / max, max];
}

function findMarkers(imageData, width, height) {
  const sums = Object.fromEntries(markerDefinitions.map(marker => [marker.key, { x: 0, y: 0, weight: 0, count: 0 }]));
  const pixels = imageData.data;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const offset = (y * width + x) * 4;
      const [h, s, v] = rgbToHsv(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      for (const marker of markerDefinitions) {
        if (!marker.matches(h, s, v)) continue;
        const weight = s * v;
        const sum = sums[marker.key];
        sum.x += x * weight;
        sum.y += y * weight;
        sum.weight += weight;
        sum.count += 1;
        break;
      }
    }
  }

  const minimumPixels = Math.max(10, width * height * 0.00018);
  const result = {};
  for (const marker of markerDefinitions) {
    const sum = sums[marker.key];
    if (sum.count >= minimumPixels && sum.weight > 0) {
      result[marker.key] = {
        x: sum.x / sum.weight,
        y: sum.y / sum.weight,
        count: sum.count,
      };
    }
  }
  return result;
}

function solveLinear(matrix, values) {
  const n = values.length;
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-9) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let j = column; j <= n; j += 1) rows[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let j = column; j <= n; j += 1) rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map(row => row[n]);
}

function homographyFromQuad(points) {
  const source = [points.tl, points.tr, points.br, points.bl];
  const target = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const matrix = [];
  const values = [];

  for (let i = 0; i < 4; i += 1) {
    const { x, y } = source[i];
    const [u, v] = target[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }

  return solveLinear(matrix, values);
}

function project(h, x, y) {
  if (!h) return null;
  const denominator = h[6] * x + h[7] * y + 1;
  if (Math.abs(denominator) < 1e-6) return null;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / denominator,
    y: (h[3] * x + h[4] * y + h[5]) / denominator,
  };
}

function polygonArea(points) {
  const ordered = [points.tl, points.tr, points.br, points.bl];
  return Math.abs(ordered.reduce((sum, point, index) => {
    const next = ordered[(index + 1) % ordered.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function drawOverlay(markers, width, height) {
  const cssWidth = overlayCanvas.clientWidth;
  const cssHeight = overlayCanvas.clientHeight;
  const scale = Math.min(cssWidth / width, cssHeight / height);
  const offsetX = (cssWidth - width * scale) / 2;
  const offsetY = (cssHeight - height * scale) / 2;
  overlay.clearRect(0, 0, cssWidth, cssHeight);
  for (const definition of markerDefinitions) {
    const marker = markers[definition.key];
    if (!marker) continue;
    const x = offsetX + marker.x * scale;
    const y = offsetY + marker.y * scale;
    overlay.strokeStyle = definition.color;
    overlay.lineWidth = 4;
    overlay.beginPath();
    overlay.arc(x, y, 15, 0, Math.PI * 2);
    overlay.stroke();
    overlay.fillStyle = definition.color;
    overlay.font = "700 12px system-ui";
    overlay.fillText(definition.label, x + 20, y + 4);
  }
}

function updateReadout(aim, confidence) {
  phoneX.textContent = (aim.x * 100).toFixed(1);
  phoneY.textContent = (aim.y * 100).toFixed(1);
  confidenceEl.textContent = `${Math.round(confidence * 100)}%`;
}

async function sendAim(aim, confidence, mode) {
  const now = performance.now();
  if (now - lastSent < 55 && mode === "camera") return;
  lastSent = now;
  try {
    await fetch("/api/aim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...aim, confidence, mode, deviceId }),
    });
    connectionChip.textContent = "화면 연결됨";
    connectionChip.classList.add("is-live");
  } catch {
    connectionChip.textContent = "연결 끊김";
    connectionChip.classList.remove("is-live");
  }
}

function processImage(source, width, height, mode) {
  analysisCanvas.width = 320;
  analysisCanvas.height = Math.max(180, Math.round(320 * height / width));
  analysis.drawImage(source, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const frame = analysis.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  const markers = findMarkers(frame, analysisCanvas.width, analysisCanvas.height);
  const count = Object.keys(markers).length;
  detectStatus.textContent = `기준점 ${count} / 4`;
  detectStatus.classList.toggle("is-ready", count === 4);
  drawOverlay(markers, analysisCanvas.width, analysisCanvas.height);

  if (count !== 4) return false;
  const h = homographyFromQuad(markers);
  const rawAim = project(h, analysisCanvas.width / 2, analysisCanvas.height / 2);
  if (!rawAim) return false;
  const areaRatio = polygonArea(markers) / (analysisCanvas.width * analysisCanvas.height);
  const confidence = Math.min(1, areaRatio / 0.36);
  smoothAim = {
    x: smoothAim.x + (rawAim.x - smoothAim.x) * (mode === "camera" ? 0.3 : 1),
    y: smoothAim.y + (rawAim.y - smoothAim.y) * (mode === "camera" ? 0.3 : 1),
  };
  updateReadout(smoothAim, confidence);
  sendAim(smoothAim, confidence, mode);
  return true;
}

function resizeOverlay() {
  const rect = cameraStage.getBoundingClientRect();
  overlayCanvas.width = Math.round(rect.width * devicePixelRatio);
  overlayCanvas.height = Math.round(rect.height * devicePixelRatio);
  overlayCanvas.style.width = `${rect.width}px`;
  overlayCanvas.style.height = `${rect.height}px`;
  overlay.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function cameraLoop() {
  if (!running || video.readyState < 2) return;
  processImage(video, video.videoWidth, video.videoHeight, "camera");
  requestAnimationFrame(cameraLoop);
}

startCameraButton.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    secureNotice.hidden = false;
    secureNotice.textContent = "이 주소에서는 실시간 카메라를 열 수 없습니다. 사진 측정이나 시뮬레이션으로 먼저 시험하세요.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    cameraEmpty.hidden = true;
    running = true;
    startCameraButton.textContent = "카메라 실행 중";
    startCameraButton.disabled = true;
    resizeOverlay();
    requestAnimationFrame(cameraLoop);
  } catch (error) {
    secureNotice.hidden = false;
    secureNotice.textContent = error.name === "NotAllowedError"
      ? "카메라 권한이 거부되었습니다. 브라우저 설정에서 권한을 허용하거나 사진 측정을 사용하세요."
      : "카메라를 시작하지 못했습니다. 사진 측정이나 시뮬레이션으로 먼저 시험하세요.";
  }
});

photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  const image = new Image();
  image.onload = () => {
    cameraEmpty.hidden = true;
    video.poster = image.src;
    video.style.backgroundImage = `url(${image.src})`;
    video.style.backgroundSize = "contain";
    video.style.backgroundPosition = "center";
    video.style.backgroundRepeat = "no-repeat";
    resizeOverlay();
    const found = processImage(image, image.naturalWidth, image.naturalHeight, "photo");
    if (!found) {
      secureNotice.hidden = false;
      secureNotice.textContent = "네 색 기준점을 모두 찾지 못했습니다. 화면 전체와 네 모서리가 보이게 다시 촬영하세요.";
    }
    URL.revokeObjectURL(image.src);
  };
  image.src = URL.createObjectURL(file);
});

function simulate(event) {
  const rect = simPad.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  simDot.style.left = `${x * 100}%`;
  simDot.style.top = `${y * 100}%`;
  smoothAim = { x, y };
  updateReadout(smoothAim, 1);
  sendAim(smoothAim, 1, "simulation");
}

simPad.addEventListener("pointerdown", event => {
  simPad.setPointerCapture(event.pointerId);
  simulate(event);
});
simPad.addEventListener("pointermove", event => {
  if (simPad.hasPointerCapture(event.pointerId)) simulate(event);
});

if (!window.isSecureContext) secureNotice.hidden = false;
fetch("/api/info")
  .then(() => {
    connectionChip.textContent = "화면 대기 중";
  })
  .catch(() => {
    connectionChip.textContent = "서버 연결 안 됨";
  });
window.addEventListener("resize", resizeOverlay);
resizeOverlay();
