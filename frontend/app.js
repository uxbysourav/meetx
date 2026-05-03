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
  chatRecipient: document.querySelector("#chatRecipient"),
  chatInput: document.querySelector("#chatInput"),
  toggleMic: document.querySelector("#toggleMic"),
  toggleCamera: document.querySelector("#toggleCamera"),
  raiseHand: document.querySelector("#raiseHand"),
  shareScreen: document.querySelector("#shareScreen"),
  leaveRoom: document.querySelector("#leaveRoom"),
  toggleBoard: document.querySelector("#toggleBoard"),
  clearBoard: document.querySelector("#clearBoard"),
  boardTools: document.querySelector("#boardTools"),
  boardPen: document.querySelector("#boardPen"),
  boardEraser: document.querySelector("#boardEraser"),
  boardColor: document.querySelector("#boardColor"),
  boardSize: document.querySelector("#boardSize"),
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
  audioContext: null,
  audioMonitors: new Map(),
  localStream: null,
  screenStream: null,
  screenShareApproved: false,
  screenSharing: false,
  notificationPermissionAsked: false,
  boardOpen: false,
  boardTool: "pen",
  isDrawing: false,
  lastPoint: null
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const video720p = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 }
};

const shareIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H4z"></path><path d="M12 16v5M8 21h8M12 12V8M9 10l3-3 3 3"></path></svg>`;
const stopShareIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"></path><path d="m8 8 8 8M16 8l-8 8"></path></svg>`;
const fullscreenIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"></path></svg>`;

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

function requestNotificationPermission() {
  if (!("Notification" in window) || state.notificationPermissionAsked) return;
  state.notificationPermissionAsked = true;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function notifyUser(title, body) {
  showToast(body ? `${title}: ${body}` : title);
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(title, { body });
  }
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
  if (!response.ok) {
    if (response.status === 404) throw new Error(body.error || "Meeting code was not found.");
    if (response.status >= 500) throw new Error("Backend is waking up or temporarily unavailable. Please try again in a few seconds.");
    throw new Error(body.error || `Request failed with status ${response.status}.`);
  }
  return body;
}

function ensureLocalStream() {
  if (!state.localStream) state.localStream = new MediaStream();
  return state.localStream;
}

async function requestMediaAfterJoin() {
  ensureLocalStream();
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera and microphone are not available in this browser. You joined without media.");
    addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
    return state.localStream;
  }

  const grantedTracks = [];
  const denied = [];

  for (const request of [
    { kind: "audio", constraints: { audio: true, video: false }, label: "Microphone" },
    { kind: "video", constraints: { audio: false, video: video720p }, label: "Camera" }
  ]) {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia(request.constraints);
      mediaStream.getTracks().forEach((track) => {
        state.localStream.addTrack(track);
        grantedTracks.push(track);
      });
    } catch {
      denied.push(request.label);
    }
  }

  if (grantedTracks.length) {
    await attachLocalTracksToPeers(new MediaStream(grantedTracks));
    addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
    showToast("Media is ready.");
  } else {
    addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
    showToast("Camera and microphone were blocked. You still joined without media.");
  }

  if (denied.length && grantedTracks.length) {
    showToast(`${denied.join(" and ")} blocked. You can continue with available media.`);
  }
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
  ensureLocalStream();
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

  addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
  resizeBoard();
  requestMediaAfterJoin();
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
  stopAudioMonitor(userId);
  document.querySelector(`[data-tile="${userId}"]`)?.remove();
  renderParticipants();
}

function handleParticipantUpdated(user) {
  state.participants.set(user.id, user);
  renderParticipants();
  setTilePresenting(user.id, Boolean(user.presenting));
  if (user.id === state.user?.id) setTilePresenting("local", Boolean(user.presenting));
  updateHandButton();
}

async function createPeer(userId, initiator) {
  if (state.peers.has(userId)) return state.peers.get(userId);
  const peer = new RTCPeerConnection(rtcConfig);
  state.peers.set(userId, peer);

  state.localStream?.getTracks().forEach((track) => {
    const sender = peer.addTrack(track, state.localStream);
    limitSenderQuality(sender);
  });
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit("signal", { to: userId, signal: { candidate } });
  };
  peer.ontrack = ({ streams }) => {
    const user = state.participants.get(userId);
    addVideoTile(userId, streams[0], user?.name || "Guest");
    setTilePresenting(userId, Boolean(user?.presenting));
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
  stopAudioMonitor(userId);
}

async function attachLocalTracksToPeers(stream) {
  for (const [userId, peer] of state.peers.entries()) {
    for (const track of stream.getTracks()) {
      const alreadySending = peer.getSenders().some((sender) => sender.track?.id === track.id);
      if (!alreadySending) {
        const sender = peer.addTrack(track, state.localStream);
        await limitSenderQuality(sender);
      }
    }
    if (peer.signalingState === "stable") {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      state.socket.emit("signal", { to: userId, signal: { description: peer.localDescription } });
    }
  }
}

async function limitSenderQuality(sender) {
  if (!sender?.getParameters) return;
  const params = sender.getParameters();
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = sender.track?.kind === "video" ? 1500000 : 64000;
  params.encodings[0].maxFramerate = sender.track?.kind === "video" ? 30 : undefined;
  await sender.setParameters(params).catch(() => {});
}

function addVideoTile(id, stream, label, muted = false) {
  let tile = document.querySelector(`[data-tile="${id}"]`);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "tile";
    tile.dataset.tile = id;
    tile.innerHTML = `<video autoplay playsinline></video><button class="tile-fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen">${fullscreenIcon}</button><span class="label"></span>`;
    els.videoGrid.appendChild(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.muted = muted;
  tile.querySelector(".label").textContent = label;
  monitorAudioLevel(id, stream);
}

function setTilePresenting(id, presenting) {
  document.querySelector(`[data-tile="${id}"]`)?.classList.toggle("presenting", presenting);
}

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    state.audioContext = new AudioContextClass();
  }
  if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => {});
  return state.audioContext;
}

function stopAudioMonitor(id) {
  const monitor = state.audioMonitors.get(id);
  if (!monitor) return;
  cancelAnimationFrame(monitor.frameId);
  monitor.source.disconnect();
  document.querySelector(`[data-tile="${id}"]`)?.classList.remove("speaking");
  state.audioMonitors.delete(id);
}

function monitorAudioLevel(id, stream) {
  stopAudioMonitor(id);
  if (!stream?.getAudioTracks().length) return;
  const audioContext = getAudioContext();
  if (!audioContext) return;

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const monitor = { source, frameId: 0 };
  state.audioMonitors.set(id, monitor);

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = value - 128;
      sum += centered * centered;
    }
    const volume = Math.sqrt(sum / data.length);
    document.querySelector(`[data-tile="${id}"]`)?.classList.toggle("speaking", volume > 8);
    monitor.frameId = requestAnimationFrame(tick);
  };

  tick();
}

function renderParticipants() {
  const users = [...state.participants.values()];
  els.participantCount.textContent = users.length;
  const amAdmin = state.user?.isAdmin;
  els.clearBoard.classList.toggle("hidden", !amAdmin);
  els.boardTools.classList.toggle("hidden", !state.boardOpen || !amAdmin);
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !amAdmin));
  els.participants.innerHTML = users.map((user) => {
    const canModerate = amAdmin && user.id !== state.user.id;
    const badges = [
      user.isAdmin ? `<span title="Admin" aria-label="Admin">Admin</span>` : "",
      user.muted ? `<span title="Muted microphone" aria-label="Muted microphone"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 5 2.2"></path><path d="M19 10v2a7 7 0 0 1-.7 3M12 19v3M8 22h8M4 4l16 16"></path></svg></span>` : "",
      user.handRaised ? `<span title="Hand raised" aria-label="Hand raised"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V5a2 2 0 0 1 4 0v5"></path><path d="M11 10V4a2 2 0 0 1 4 0v7"></path><path d="M15 11V6a2 2 0 0 1 4 0v8a7 7 0 0 1-14 0v-3a2 2 0 0 1 4 0v2"></path></svg></span>` : "",
      user.screenRequest ? `<span title="Wants to present" aria-label="Wants to present"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H4z"></path><path d="M12 16v5M8 21h8M12 12V8M9 10l3-3 3 3"></path></svg></span>` : "",
      user.presenting ? `<span title="Presenting" aria-label="Presenting"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H4z"></path><path d="M8 21h8M12 16v5"></path></svg></span>` : ""
    ].filter(Boolean).join("");
    return `
      <article class="participant">
        <span class="avatar">${escapeHtml(user.name[0] || "?")}</span>
        <div>
          <div class="person-name">${escapeHtml(user.name)}</div>
          <div class="badges">${badges}</div>
        </div>
        ${canModerate ? `
          <div class="mini-actions">
            ${user.screenRequest ? `<button data-action="approve" data-id="${user.id}" title="Approve screen share" aria-label="Approve screen share"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></button>` : ""}
            <button data-action="kick" data-id="${user.id}" title="Remove participant" aria-label="Remove participant"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
          </div>` : ""}
      </article>
    `;
  }).join("");
  renderChatRecipients(users);
  updateHandButton();
}

function renderChatRecipients(users) {
  const selected = els.chatRecipient.value || "everyone";
  const options = [`<option value="everyone">Everyone</option>`]
    .concat(users
      .filter((user) => user.id !== state.user?.id)
      .map((user) => `<option value="${user.id}">${escapeHtml(user.name)}</option>`));
  els.chatRecipient.innerHTML = options.join("");
  els.chatRecipient.value = users.some((user) => user.id === selected) || selected === "everyone" ? selected : "everyone";
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
  item.className = `message${message.private ? " private" : ""}`;
  const targetLabel = message.private ? "Private" : "Everyone";
  item.innerHTML = `<strong>${escapeHtml(message.name)} <span>${targetLabel}</span></strong><p>${escapeHtml(message.text)}</p>`;
  els.messages.appendChild(item);
  els.messages.scrollTop = els.messages.scrollHeight;
  if (message.userId !== state.user?.id) {
    notifyUser(message.private ? `Private message from ${message.name}` : `Message from ${message.name}`, message.text);
  }
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

async function setOutgoingVideoTrack(track) {
  for (const [userId, peer] of state.peers.entries()) {
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
      await limitSenderQuality(sender);
    } else {
      const sender = peer.addTrack(track, track === state.screenStream?.getVideoTracks()[0] ? state.screenStream : state.localStream);
      await limitSenderQuality(sender);
      if (peer.signalingState === "stable") {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        state.socket.emit("signal", { to: userId, signal: { description: peer.localDescription } });
      }
    }
  }
}

async function clearOutgoingVideoTrack() {
  for (const peer of state.peers.values()) {
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (sender) await sender.replaceTrack(null);
  }
}

async function startScreenShare() {
  if (state.screenSharing) {
    await stopScreenShare();
    return;
  }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: video720p, audio: false });
    const screenTrack = state.screenStream.getVideoTracks()[0];
    await screenTrack.applyConstraints(video720p).catch(() => {});
    await setOutgoingVideoTrack(screenTrack);
    addVideoTile("local", state.screenStream, `${state.user.name} presenting`, true);
    setTilePresenting("local", true);
    updateShareButton(true);
    state.socket.emit("screen-started");
    showToast("Screen sharing started.");
    screenTrack.onended = () => stopScreenShare();
  } catch {
    showToast("Screen sharing could not start.");
  }
}

async function stopScreenShare() {
  if (!state.screenSharing && !state.screenStream) return;
  const cameraTrack = state.localStream?.getVideoTracks()[0];
  if (cameraTrack) await setOutgoingVideoTrack(cameraTrack);
  else await clearOutgoingVideoTrack();
  state.screenStream?.getTracks().forEach((track) => track.stop());
  state.screenStream = null;
  addVideoTile("local", state.localStream, `${state.user.name} (you)`, true);
  setTilePresenting("local", false);
  updateShareButton(false);
  state.socket.emit("screen-stopped");
  showToast("Screen sharing stopped.");
}

function updateShareButton(sharing) {
  state.screenSharing = sharing;
  els.shareScreen.classList.toggle("active", sharing);
  els.shareScreen.innerHTML = sharing ? stopShareIcon : shareIcon;
  const label = sharing ? "Stop screen sharing" : "Share screen";
  els.shareScreen.setAttribute("title", label);
  els.shareScreen.setAttribute("aria-label", label);
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
  ctx.globalCompositeOperation = line.tool === "eraser" ? "destination-out" : "source-over";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(line.from.x * els.whiteboard.width, line.from.y * els.whiteboard.height);
  ctx.lineTo(line.to.x * els.whiteboard.width, line.to.y * els.whiteboard.height);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
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
  state.audioMonitors.forEach((_monitor, id) => stopAudioMonitor(id));
  state.audioContext?.close().catch(() => {});
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
  requestNotificationPermission();
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
  requestNotificationPermission();
});

els.copyCode.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  showToast("Meeting code copied.");
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  state.socket.emit("chat-message", { text, to: els.chatRecipient.value || "everyone" });
  els.chatInput.value = "";
});

els.videoGrid.addEventListener("click", (event) => {
  const button = event.target.closest(".tile-fullscreen");
  if (!button) return;
  const tile = button.closest(".tile");
  if (!tile) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  tile.requestFullscreen?.().catch(() => showToast("Fullscreen is not available here."));
});

els.participants.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  state.socket.emit("admin-action", { action: button.dataset.action, targetId: button.dataset.id });
});

els.toggleMic.addEventListener("click", () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) {
    showToast("Microphone is not enabled for this meeting.");
    return;
  }
  track.enabled = !track.enabled;
  const label = track.enabled ? "Mute microphone" : "Unmute microphone";
  els.toggleMic.setAttribute("aria-label", label);
  els.toggleMic.setAttribute("title", label);
  els.toggleMic.classList.toggle("muted", !track.enabled);
  state.socket?.emit("media-state", { muted: !track.enabled });
});

els.toggleCamera.addEventListener("click", () => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) {
    showToast("Camera is not enabled for this meeting.");
    return;
  }
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
  els.boardTools.classList.toggle("hidden", !state.boardOpen || !state.user?.isAdmin);
  if (state.boardOpen) resizeBoard();
});

els.boardPen.addEventListener("click", () => {
  state.boardTool = "pen";
  els.boardPen.classList.add("active");
  els.boardEraser.classList.remove("active");
});

els.boardEraser.addEventListener("click", () => {
  state.boardTool = "eraser";
  els.boardEraser.classList.add("active");
  els.boardPen.classList.remove("active");
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
  const line = {
    from: state.lastPoint,
    to: nextPoint,
    color: els.boardColor.value,
    width: Number(els.boardSize.value),
    tool: state.boardTool
  };
  drawLine(line);
  state.socket.emit("whiteboard-draw", line);
  state.lastPoint = nextPoint;
});

window.addEventListener("pointerup", () => {
  state.isDrawing = false;
  state.lastPoint = null;
});

window.addEventListener("resize", resizeBoard);
