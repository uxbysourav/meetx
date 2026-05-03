const els = {
  lobby: document.querySelector("#lobby"),
  meeting: document.querySelector("#meeting"),
  createRoomForm: document.querySelector("#createRoomForm"),
  joinRoomForm: document.querySelector("#joinRoomForm"),
  showCreate: document.querySelector("#showCreate"),
  showJoin: document.querySelector("#showJoin"),
  lobbyActions: document.querySelector("#lobbyActions"),
  roomPanel: document.querySelector("#roomPanel"),
  themeToggle: document.querySelector("#themeToggle"),
  infoButton: document.querySelector("#infoButton"),
  infoModal: document.querySelector("#infoModal"),
  closeInfo: document.querySelector("#closeInfo"),
  creatorName: document.querySelector("#creatorName"),
  joinName: document.querySelector("#joinName"),
  roomCode: document.querySelector("#roomCode"),
  copyCode: document.querySelector("#copyCode"),
  connectionStatus: document.querySelector("#connectionStatus"),
  participantCount: document.querySelector("#participantCount"),
  participants: document.querySelector("#participants"),
  videoGrid: document.querySelector("#videoGrid"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  toggleMic: document.querySelector("#toggleMic"),
  toggleCamera: document.querySelector("#toggleCamera"),
  raiseHand: document.querySelector("#raiseHand"),
  shareScreen: document.querySelector("#shareScreen"),
  leaveRoom: document.querySelector("#leaveRoom"),
  toggleBoard: document.querySelector("#toggleBoard"),
  clearBoard: document.querySelector("#clearBoard"),
  whiteboard: document.querySelector("#whiteboard"),
  toast: document.querySelector("#toast")
};

const apiUrl = new URLSearchParams(location.search).get("api")
  || localStorage.getItem("meetXApiUrl")
  || window.MEET_X_API_URL;

const state = {
  socket: null,
  roomCode: "",
  user: null,
  participants: new Map(),
  peers: new Map(),
  localStream: null,
  screenStream: null,
  screenShareApproved: false,
  boardOpen: false,
  isDrawing: false,
  lastPoint: null
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function getPreferredTheme() {
  return localStorage.getItem("meetXThemePreference") || (systemThemeQuery.matches ? "dark" : "light");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.classList.toggle("dark", theme === "dark");
  els.themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  els.themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
}

applyTheme(getPreferredTheme());

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.add("hidden"), 3600);
}

function setStatus(text, online = false) {
  els.connectionStatus.textContent = text;
  els.connectionStatus.classList.toggle("online", online);
}

function normalizeCode(value) {
  return value.trim().toUpperCase();
}

function showLobbyForm(mode) {
  const createMode = mode === "create";
  els.roomPanel?.setAttribute("data-mode", mode);
  els.lobbyActions.setAttribute("data-mode", mode);
  els.createRoomForm.classList.toggle("active", createMode);
  els.joinRoomForm.classList.toggle("active", !createMode);
  els.createRoomForm.setAttribute("aria-hidden", String(!createMode));
  els.joinRoomForm.setAttribute("aria-hidden", String(createMode));
  els.showCreate.classList.toggle("active", createMode);
  els.showJoin.classList.toggle("active", !createMode);
}

async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
  } catch {
    throw new Error("Backend is not reachable. Check the API URL in config.js.");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed. Please try again.");
  return body;
}

async function ensureMedia() {
  if (state.localStream) return state.localStream;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (error) {
    showToast("Camera or microphone was blocked. Joining with receive-only mode.");
    state.localStream = new MediaStream();
  }
  addVideoTile("local", state.localStream, "You", true);
  return state.localStream;
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io(apiUrl, { transports: ["websocket", "polling"] });

  state.socket.on("connect", () => setStatus("Connected", true));
  state.socket.on("disconnect", () => setStatus("Reconnecting..."));
  state.socket.on("connect_error", () => showToast("Could not connect to backend. Check config.js API URL."));
  state.socket.on("room-state", handleRoomState);
  state.socket.on("participant-joined", handleParticipantJoined);
  state.socket.on("participant-left", handleParticipantLeft);
  state.socket.on("participant-updated", handleParticipantUpdated);
  state.socket.on("chat-message", addMessage);
  state.socket.on("admin-message", ({ message }) => showToast(message));
  state.socket.on("kicked", () => {
    showToast("You were removed by the admin.");
    leaveRoom(false);
  });
  state.socket.on("screen-permission", ({ approved }) => {
    state.screenShareApproved = approved;
    showToast(approved ? "Screen sharing approved." : "Screen sharing request denied.");
    if (approved) startScreenShare();
  });
  state.socket.on("whiteboard-draw", drawRemoteLine);
  state.socket.on("whiteboard-clear", clearCanvas);
  state.socket.on("signal", handleSignal);
}

async function enterRoom({ name, code, create }) {
  const localStream = await ensureMedia();
  const endpoint = create ? "/api/rooms" : `/api/rooms/${code}/join`;
  const payload = await requestJson(endpoint, {
    method: create ? "POST" : "PUT",
    body: JSON.stringify({ name })
  });

  state.roomCode = payload.roomCode;
  state.user = payload.user;
  els.copyCode.textContent = state.roomCode;
  els.lobby.classList.add("hidden");
  els.meeting.classList.remove("hidden");
  connectSocket();

  state.socket.emit("join-room", {
    roomCode: state.roomCode,
    userId: state.user.id,
    name: state.user.name
  });

  addVideoTile("local", localStream, `${state.user.name} (you)`, true);
  resizeBoard();
}

function handleRoomState({ participants, messages, boardLines }) {
  state.participants = new Map(participants.map((user) => [user.id, user]));
  renderParticipants();
  els.messages.innerHTML = "";
  messages.forEach(addMessage);
  clearCanvas();
  boardLines.forEach(drawRemoteLine);
  participants.filter((user) => user.id !== state.user.id).forEach((user) => createPeer(user.id, true));
}

async function handleParticipantJoined(user) {
  state.participants.set(user.id, user);
  renderParticipants();
  await createPeer(user.id, false);
  showToast(`${user.name} joined.`);
}

function handleParticipantLeft({ userId }) {
  state.participants.delete(userId);
  closePeer(userId);
  document.querySelector(`[data-tile="${userId}"]`)?.remove();
  renderParticipants();
}

function handleParticipantUpdated(user) {
  state.participants.set(user.id, user);
  renderParticipants();
  updateHandButton();
}

async function createPeer(userId, initiator) {
  if (state.peers.has(userId)) return state.peers.get(userId);
  const peer = new RTCPeerConnection(rtcConfig);
  state.peers.set(userId, peer);

  state.localStream?.getTracks().forEach((track) => peer.addTrack(track, state.localStream));
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit("signal", { to: userId, signal: { candidate } });
  };
  peer.ontrack = ({ streams }) => {
    const user = state.participants.get(userId);
    addVideoTile(userId, streams[0], user?.name || "Guest");
  };
  peer.onconnectionstatechange = () => {
    if (["closed", "failed", "disconnected"].includes(peer.connectionState)) closePeer(userId);
  };

  if (initiator) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    state.socket.emit("signal", { to: userId, signal: { description: peer.localDescription } });
  }
  return peer;
}

async function handleSignal({ from, signal }) {
  const peer = await createPeer(from, false);
  if (signal.description) {
    await peer.setRemoteDescription(signal.description);
    if (signal.description.type === "offer") {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      state.socket.emit("signal", { to: from, signal: { description: peer.localDescription } });
    }
  }
  if (signal.candidate) {
    await peer.addIceCandidate(signal.candidate).catch(() => {});
  }
}

function closePeer(userId) {
  state.peers.get(userId)?.close();
  state.peers.delete(userId);
}

function addVideoTile(id, stream, label, muted = false) {
  let tile = document.querySelector(`[data-tile="${id}"]`);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "tile";
    tile.dataset.tile = id;
    tile.innerHTML = `<video autoplay playsinline></video><span class="label"></span>`;
    els.videoGrid.appendChild(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.muted = muted;
  tile.querySelector(".label").textContent = label;
}

function renderParticipants() {
  const users = [...state.participants.values()];
  els.participantCount.textContent = users.length;
  const amAdmin = state.user?.isAdmin;
  els.clearBoard.classList.toggle("hidden", !amAdmin);
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !amAdmin));
  els.participants.innerHTML = users.map((user) => {
    const canModerate = amAdmin && user.id !== state.user.id;
    const badges = [
      user.isAdmin ? "Admin" : "",
      user.handRaised ? "Hand raised" : "",
      user.screenRequest ? "Wants to present" : ""
    ].filter(Boolean).join(" | ");
    return `
      <article class="participant">
        <span class="avatar">${escapeHtml(user.name[0] || "?")}</span>
        <div>
          <div class="person-name">${escapeHtml(user.name)}</div>
          <div class="badges">${escapeHtml(badges)}</div>
        </div>
        ${canModerate ? `
          <div class="mini-actions">
            ${user.screenRequest ? `<button data-action="approve" data-id="${user.id}" title="Approve screen share" aria-label="Approve screen share"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></button>` : ""}
            <button data-action="kick" data-id="${user.id}" title="Remove participant" aria-label="Remove participant"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
          </div>` : ""}
      </article>
    `;
  }).join("");
  updateHandButton();
}

function updateHandButton() {
  const currentUser = state.participants.get(state.user?.id);
  const handRaised = Boolean(currentUser?.handRaised);
  els.raiseHand.classList.toggle("active", handRaised);
  const label = handRaised ? "Lower hand" : "Raise hand";
  els.raiseHand.setAttribute("aria-label", label);
  els.raiseHand.setAttribute("title", label);
}

function addMessage(message) {
  const item = document.createElement("article");
  item.className = "message";
  item.innerHTML = `<strong>${escapeHtml(message.name)}</strong><p>${escapeHtml(message.text)}</p>`;
  els.messages.appendChild(item);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function replaceOutgoingVideoTrack(track) {
  state.peers.forEach((peer) => {
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (sender) sender.replaceTrack(track);
  });
}

async function startScreenShare() {
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = state.screenStream.getVideoTracks()[0];
    replaceOutgoingVideoTrack(screenTrack);
    addVideoTile("local", state.screenStream, `${state.user.name} presenting`, true);
    screenTrack.onended = () => stopScreenShare();
  } catch {
    showToast("Screen sharing could not start.");
  }
}

function stopScreenShare() {
  const cameraTrack = state.localStream?.getVideoTracks()[0];
  if (cameraTrack) replaceOutgoingVideoTrack(cameraTrack);
  addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
  state.socket.emit("screen-stopped");
}

function resizeBoard() {
  const rect = els.whiteboard.getBoundingClientRect();
  els.whiteboard.width = rect.width;
  els.whiteboard.height = rect.height;
}

function getBoardPoint(event) {
  const rect = els.whiteboard.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function drawLine(line) {
  const ctx = els.whiteboard.getContext("2d");
  ctx.strokeStyle = line.color || "#111827";
  ctx.lineWidth = line.width || 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(line.from.x * els.whiteboard.width, line.from.y * els.whiteboard.height);
  ctx.lineTo(line.to.x * els.whiteboard.width, line.to.y * els.whiteboard.height);
  ctx.stroke();
}

function drawRemoteLine(line) {
  drawLine(line);
}

function clearCanvas() {
  const ctx = els.whiteboard.getContext("2d");
  ctx.clearRect(0, 0, els.whiteboard.width, els.whiteboard.height);
}

function leaveRoom(notify = true) {
  if (notify) state.socket?.emit("leave-room");
  state.socket?.disconnect();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.screenStream?.getTracks().forEach((track) => track.stop());
  state.peers.forEach((peer) => peer.close());
  location.reload();
}

els.createRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.creatorName.value.trim();
  if (!name) {
    showToast("Please enter your name before creating a room.");
    els.creatorName.focus();
    return;
  }
  enterRoom({ name, create: true }).catch((error) => showToast(error.message));
});

els.showCreate.addEventListener("click", () => showLobbyForm("create"));
els.showJoin.addEventListener("click", () => showLobbyForm("join"));

els.themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("meetXThemePreference", nextTheme);
  applyTheme(nextTheme);
});

systemThemeQuery.addEventListener("change", () => {
  if (!localStorage.getItem("meetXThemePreference")) {
    applyTheme(getPreferredTheme());
  }
});

els.infoButton.addEventListener("click", () => {
  els.infoModal.classList.remove("hidden");
  els.closeInfo.focus();
});

function closeInfoModal() {
  els.infoModal.classList.add("hidden");
  els.infoButton.focus();
}

els.closeInfo.addEventListener("click", closeInfoModal);
els.infoModal.addEventListener("click", (event) => {
  if (event.target === els.infoModal) closeInfoModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.infoModal.classList.contains("hidden")) {
    closeInfoModal();
  }
});

els.joinRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.joinName.value.trim();
  const code = normalizeCode(els.roomCode.value);
  if (!name) {
    showToast("Please enter your name before joining a room.");
    els.joinName.focus();
    return;
  }
  if (!code) {
    showToast("Please enter a meeting code.");
    els.roomCode.focus();
    return;
  }
  if (!/^[A-Z0-9]{6,8}$/.test(code)) {
    showToast("Meeting code looks invalid. Use the code shared by the admin.");
    els.roomCode.focus();
    return;
  }
  enterRoom({ name, code, create: false })
    .catch((error) => showToast(error.message));
});

els.copyCode.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  showToast("Meeting code copied.");
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  state.socket.emit("chat-message", { text });
  els.chatInput.value = "";
});

els.participants.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  state.socket.emit("admin-action", { action: button.dataset.action, targetId: button.dataset.id });
});

els.toggleMic.addEventListener("click", () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const label = track.enabled ? "Mute microphone" : "Unmute microphone";
  els.toggleMic.setAttribute("aria-label", label);
  els.toggleMic.setAttribute("title", label);
  els.toggleMic.classList.toggle("active", !track.enabled);
});

els.toggleCamera.addEventListener("click", () => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const label = track.enabled ? "Turn camera off" : "Turn camera on";
  els.toggleCamera.setAttribute("aria-label", label);
  els.toggleCamera.setAttribute("title", label);
  els.toggleCamera.classList.toggle("active", !track.enabled);
});

els.raiseHand.addEventListener("click", () => {
  if (!state.socket?.connected) return;
  state.socket.emit("raise-hand");
});

els.shareScreen.addEventListener("click", () => {
  if (state.user?.isAdmin || state.screenShareApproved) {
    startScreenShare();
    return;
  }
  state.socket.emit("request-screen-share");
  showToast("Screen sharing request sent to the admin.");
});

els.toggleBoard.addEventListener("click", () => {
  state.boardOpen = !state.boardOpen;
  els.whiteboard.classList.toggle("hidden", !state.boardOpen);
  if (state.boardOpen) resizeBoard();
});

els.clearBoard.addEventListener("click", () => {
  state.socket.emit("whiteboard-clear");
});

els.leaveRoom.addEventListener("click", () => leaveRoom());

els.whiteboard.addEventListener("pointerdown", (event) => {
  state.isDrawing = true;
  state.lastPoint = getBoardPoint(event);
});

els.whiteboard.addEventListener("pointermove", (event) => {
  if (!state.isDrawing || !state.user?.isAdmin) return;
  const nextPoint = getBoardPoint(event);
  const line = { from: state.lastPoint, to: nextPoint, color: "#111827", width: 3 };
  drawLine(line);
  state.socket.emit("whiteboard-draw", line);
  state.lastPoint = nextPoint;
});

window.addEventListener("pointerup", () => {
  state.isDrawing = false;
  state.lastPoint = null;
});

window.addEventListener("resize", resizeBoard);
