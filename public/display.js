const aim = document.querySelector("#aim");
const statusText = document.querySelector("#statusText");
const statusLight = document.querySelector("#statusLight");
const xValue = document.querySelector("#xValue");
const yValue = document.querySelector("#yValue");
const connectPanel = document.querySelector("#connectPanel");
const showPanel = document.querySelector("#showPanel");
const controllerUrl = document.querySelector("#controllerUrl");
const qrImage = document.querySelector("#qrImage");
const qrFallback = document.querySelector("#qrFallback");

let shownX = 0.5;
let shownY = 0.5;
let targetX = 0.5;
let targetY = 0.5;

async function loadConnectionInfo() {
  try {
    const response = await fetch("/api/info", { cache: "no-store" });
    const info = await response.json();
    controllerUrl.textContent = info.controllerUrl;
    controllerUrl.dataset.url = info.controllerUrl;
    const qrUrl = `https://quickchart.io/qr?size=280&margin=1&text=${encodeURIComponent(info.controllerUrl)}`;
    qrImage.src = qrUrl;
    qrImage.addEventListener("load", () => {
      qrFallback.hidden = true;
      qrImage.classList.add("is-loaded");
    });
    qrImage.addEventListener("error", () => {
      qrFallback.textContent = "QR을 불러오지 못했습니다. 옆 주소를 입력하세요.";
    });
  } catch {
    controllerUrl.textContent = "서버 주소를 확인할 수 없습니다";
  }
}

async function pollAim() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const state = await response.json();
    const active = Date.now() - state.updatedAt < 1800;
    if (active) {
      targetX = state.x;
      targetY = state.y;
      aim.classList.remove("is-waiting");
      statusLight.classList.add("is-live");
      statusText.textContent = state.mode === "camera" ? "카메라 추적 중" : state.mode === "photo" ? "사진 측정값" : "시뮬레이션 연결됨";
    } else {
      aim.classList.add("is-waiting");
      statusLight.classList.remove("is-live");
      statusText.textContent = "휴대폰 연결 대기";
    }
  } catch {
    statusText.textContent = "로컬 서버 연결 끊김";
    statusLight.classList.remove("is-live");
  }
}

function animateAim() {
  shownX += (targetX - shownX) * 0.22;
  shownY += (targetY - shownY) * 0.22;
  aim.style.left = `${shownX * 100}%`;
  aim.style.top = `${shownY * 100}%`;
  const outside = shownX < 0 || shownX > 1 || shownY < 0 || shownY > 1;
  aim.classList.toggle("is-outside", outside);
  xValue.textContent = Math.round(shownX * 100);
  yValue.textContent = Math.round(shownY * 100);
  requestAnimationFrame(animateAim);
}

document.querySelector("#fullscreenButton").addEventListener("click", async () => {
  try {
    await document.documentElement.requestFullscreen();
    connectPanel.classList.add("is-hidden");
    showPanel.classList.remove("is-hidden");
  } catch {
    statusText.textContent = "브라우저 메뉴에서 전체 화면을 선택하세요";
  }
});

document.querySelector("#hidePanel").addEventListener("click", () => {
  connectPanel.classList.add("is-hidden");
  showPanel.classList.remove("is-hidden");
});

showPanel.addEventListener("click", () => {
  connectPanel.classList.remove("is-hidden");
  showPanel.classList.add("is-hidden");
});

document.querySelector("#copyLink").addEventListener("click", async event => {
  const value = controllerUrl.dataset.url;
  if (!value) return;
  await navigator.clipboard.writeText(value);
  event.currentTarget.textContent = "복사됨";
  setTimeout(() => (event.currentTarget.textContent = "주소 복사"), 1400);
});

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  void Promise.resolve(context.registerTool({
    name: "set_test_aim",
    title: "테스트 조준점 이동",
    description: "PHONE AIM 프로토타입의 화면 조준점을 지정한 퍼센트 좌표로 이동해 연결 상태를 시험합니다.",
    inputSchema: {
      type: "object",
      properties: {
        xPercent: { type: "number", minimum: 0, maximum: 100 },
        yPercent: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["xPercent", "yPercent"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const x = Number(input?.xPercent);
      const y = Number(input?.yPercent);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        throw new Error("xPercent와 yPercent는 0부터 100 사이의 숫자여야 합니다.");
      }
      const response = await fetch("/api/aim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: x / 100, y: y / 100, confidence: 1, mode: "simulation", deviceId: "webmcp-test" }),
      });
      if (!response.ok) throw new Error("테스트 좌표를 전송하지 못했습니다.");
      return { xPercent: x, yPercent: y, status: "updated" };
    },
  }, { signal: lifecycle.signal })).catch(() => {});
}

loadConnectionInfo();
pollAim();
setInterval(pollAim, 80);
requestAnimationFrame(animateAim);
registerWebMcp();
