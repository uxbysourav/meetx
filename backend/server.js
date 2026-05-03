const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const MAX_MESSAGES = 100;
const MAX_BOARD_LINES = 2500;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST", "PUT"]
  }
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

const rooms = new Map();

function createCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  return String(name || "").trim().slice(0, 40);
}

function serializeParticipants(room) {
  return [...room.participants.values()].map(({ socketId, ...user }) => user);
}

function findUser(room, userId) {
  return room?.participants.get(userId);
}

function requireAdmin(room, socket) {
  const user = findUser(room, socket.data.userId);
  return Boolean(user?.isAdmin);
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("participants", serializeParticipants(room));
}

function removeUserFromRoom(socket, notify = true) {
  const { roomCode, userId } = socket.data;
  const room = rooms.get(roomCode);
  if (!room || !userId) return;
  const user = room.participants.get(userId);
  room.participants.delete(userId);
  socket.leave(roomCode);
  if (notify && user) {
    socket.to(roomCode).emit("participant-left", { userId, name: user.name });
  }
  if (room.participants.size === 0) {
    rooms.delete(roomCode);
    return;
  }
  if (user?.isAdmin) {
    const nextAdmin = room.participants.values().next().value;
    nextAdmin.isAdmin = true;
    io.to(roomCode).emit("participant-updated", publicUser(nextAdmin));
    io.to(roomCode).emit("admin-message", { message: `${nextAdmin.name} is now admin.` });
  }
}

function publicUser(user) {
  const { socketId, ...safeUser } = user;
  return safeUser;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "Meet X backend",
    health: "/api/health"
  });
});

app.post("/api/rooms", (req, res) => {
  const name = sanitizeName(req.body.name);
  if (!name) return res.status(400).json({ error: "Name is required." });

  const roomCode = createCode();
  const user = {
    id: randomUUID(),
    name,
    isAdmin: true,
    handRaised: false,
    screenRequest: false,
    presenting: false,
    socketId: null
  };

  rooms.set(roomCode, {
    code: roomCode,
    adminId: user.id,
    participants: new Map([[user.id, user]]),
    messages: [],
    boardLines: [],
    createdAt: Date.now()
  });

  res.status(201).json({ roomCode, user: publicUser(user) });
});

app.put("/api/rooms/:roomCode/join", (req, res) => {
  const roomCode = String(req.params.roomCode || "").toUpperCase();
  const room = rooms.get(roomCode);
  const name = sanitizeName(req.body.name);
  if (!room) return res.status(404).json({ error: "Meeting code was not found." });
  if (!name) return res.status(400).json({ error: "Name is required." });

  const user = {
    id: randomUUID(),
    name,
    isAdmin: false,
    handRaised: false,
    screenRequest: false,
    presenting: false,
    socketId: null
  };

  room.participants.set(user.id, user);
  res.json({ roomCode, user: publicUser(user) });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomCode, userId }) => {
    const code = String(roomCode || "").toUpperCase();
    const room = rooms.get(code);
    const user = findUser(room, userId);
    if (!room || !user) {
      socket.emit("admin-message", { message: "Meeting no longer exists." });
      return;
    }

    socket.data.roomCode = code;
    socket.data.userId = userId;
    user.socketId = socket.id;
    socket.join(code);

    socket.emit("room-state", {
      participants: serializeParticipants(room),
      messages: room.messages,
      boardLines: room.boardLines
    });
    socket.to(code).emit("participant-joined", publicUser(user));
  });

  socket.on("chat-message", ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    const user = findUser(room, socket.data.userId);
    const cleanText = String(text || "").trim().slice(0, 400);
    if (!room || !user || !cleanText) return;
    const message = { id: randomUUID(), userId: user.id, name: user.name, text: cleanText, at: Date.now() };
    room.messages.push(message);
    room.messages = room.messages.slice(-MAX_MESSAGES);
    io.to(room.code).emit("chat-message", message);
  });

  socket.on("raise-hand", () => {
    const room = rooms.get(socket.data.roomCode);
    const user = findUser(room, socket.data.userId);
    if (!room || !user) return;
    user.handRaised = !user.handRaised;
    io.to(room.code).emit("participant-updated", publicUser(user));
  });

  socket.on("request-screen-share", () => {
    const room = rooms.get(socket.data.roomCode);
    const user = findUser(room, socket.data.userId);
    if (!room || !user) return;
    if (user.isAdmin) {
      socket.emit("screen-permission", { approved: true });
      return;
    }
    user.screenRequest = true;
    io.to(room.code).emit("participant-updated", publicUser(user));
    const admin = [...room.participants.values()].find((participant) => participant.isAdmin);
    if (admin?.socketId) {
      io.to(admin.socketId).emit("admin-message", { message: `${user.name} wants to share their screen.` });
    }
  });

  socket.on("screen-stopped", () => {
    const room = rooms.get(socket.data.roomCode);
    const user = findUser(room, socket.data.userId);
    if (!room || !user) return;
    user.presenting = false;
    io.to(room.code).emit("participant-updated", publicUser(user));
  });

  socket.on("admin-action", ({ action, targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !requireAdmin(room, socket)) return;
    const target = findUser(room, targetId);
    if (!target || target.isAdmin) return;

    if (action === "kick") {
      if (target.socketId) io.to(target.socketId).emit("kicked");
      room.participants.delete(target.id);
      io.to(room.code).emit("participant-left", { userId: target.id, name: target.name });
      return;
    }

    if (action === "approve") {
      target.screenRequest = false;
      target.presenting = true;
      if (target.socketId) io.to(target.socketId).emit("screen-permission", { approved: true });
      io.to(room.code).emit("participant-updated", publicUser(target));
    }
  });

  socket.on("whiteboard-draw", (line) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !requireAdmin(room, socket)) return;
    const cleanLine = normalizeLine(line);
    if (!cleanLine) return;
    room.boardLines.push(cleanLine);
    room.boardLines = room.boardLines.slice(-MAX_BOARD_LINES);
    socket.to(room.code).emit("whiteboard-draw", cleanLine);
  });

  socket.on("whiteboard-clear", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !requireAdmin(room, socket)) return;
    room.boardLines = [];
    io.to(room.code).emit("whiteboard-clear");
  });

  socket.on("signal", ({ to, signal }) => {
    const room = rooms.get(socket.data.roomCode);
    const target = findUser(room, to);
    if (!room || !target?.socketId) return;
    io.to(target.socketId).emit("signal", { from: socket.data.userId, signal });
  });

  socket.on("leave-room", () => removeUserFromRoom(socket));
  socket.on("disconnect", () => removeUserFromRoom(socket));
});

function normalizeLine(line) {
  if (!line?.from || !line?.to) return null;
  const toUnit = (value) => Math.min(1, Math.max(0, Number(value)));
  return {
    from: { x: toUnit(line.from.x), y: toUnit(line.from.y) },
    to: { x: toUnit(line.to.x), y: toUnit(line.to.y) },
    color: /^#[0-9a-f]{6}$/i.test(line.color) ? line.color : "#111827",
    width: Math.min(12, Math.max(1, Number(line.width) || 3))
  };
}

server.listen(PORT, () => {
  console.log(`Meet X backend listening on ${PORT}`);
});
