const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Allow CORS for frontend access
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Store online users: Map<userId, socketId[]>
const onlineUsers = new Map();

// Middleware for authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error("Authentication error: Token required"));
  }

  // NOTE: In a production environment, you must verify the JWT token here.
  // Example with jsonwebtoken:
  // jwt.verify(token, process.env.NEXTAUTH_SECRET, (err, decoded) => {
  //   if (err) return next(new Error("Authentication error"));
  //   socket.userId = decoded.sub; // or decoded.id
  //   next();
  // });

  // For this standalone setup without shared secrets/env access loaded,
  // we will decode the token blindly or expect the client to identify itself.
  // WARNING: This is for demonstration purposes.
  try {
    // Attempt to decode payload if it's a real JWT
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      socket.userId = payload.sub || payload.id || payload.userId;
    } else {
        // Fallback: assume token IS the userId for testing
        socket.userId = token;
    }
    
    if (!socket.userId) {
        return next(new Error("Authentication error: Invalid user ID"));
    }
    
    next();
  } catch (e) {
    console.error("Token parsing error:", e);
    next(new Error("Authentication error"));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`✅ User connected: ${userId} (Socket ID: ${socket.id})`);

  // Join a room specifically for this user to allow targeted messages
  socket.join(`user:${userId}`);

  // Track online status
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);

  // Broadcast user online status
  io.emit('user:online', { userId });

  // --- Event Handlers ---

  // Handle Client-Sent Messages (Direct Relay)
  // This allows the frontend to emit 'message:send' and have it relayed to the recipient
  // without going through the Next.js API if desired, OR for simple signaling.
  socket.on('message:send', (data) => {
    const { receiverId, content, id } = data;
    console.log(`📩 Message from ${userId} to ${receiverId}: ${content}`);

    // Emit to receiver
    io.to(`user:${receiverId}`).emit('message:new', {
      id: id || Date.now().toString(),
      content,
      senderId: userId,
      receiverId,
      createdAt: new Date().toISOString(),
      isRead: false,
      sender: {
          id: userId,
          // In a real app, we'd fetch full user details or expect them in the payload
          firstName: "User", 
          lastName: userId,
          role: "UNKNOWN",
          avatarUrl: null,
          image: null
      }
    });

    // Ack to sender (optional, if they are listening for confirmation)
    socket.emit('message:sent', { id });
  });
  
  socket.on('message:read', (data) => {
    const { messageId, senderId } = data;
    console.log(`👁️ Message ${messageId} read by ${userId}`);
    
    // Relay 'read' status back to the original sender
    io.to(`user:${senderId}`).emit('message:read_relay', { messageId, readerId: userId });
  });

  socket.on('typing:start', ({ receiverId }) => {
    io.to(`user:${receiverId}`).emit('user:typing', { userId, isTyping: true });
  });

  socket.on('typing:stop', ({ receiverId }) => {
    io.to(`user:${receiverId}`).emit('user:typing', { userId, isTyping: false });
  });

  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${userId}`);
    
    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        io.emit('user:offline', { userId });
      }
    }
  });
});

// --- REST API for Server-to-Server Broadcasting ---
// This allows the Next.js API routes to trigger socket events securely
app.post('/api/broadcast', (req, res) => {
  // TODO: Add secret key check header to prevent unauthorized calls
  // const secret = req.headers['x-internal-secret'];
  // if (secret !== process.env.INTERNAL_SECRET) return res.sendStatus(403);

  const { event, data, toUserId } = req.body;

  if (!event || !data) {
    return res.status(400).json({ error: "Missing event or data" });
  }

  if (toUserId) {
    console.log(`📢 API Emitting '${event}' to user:${toUserId}`);
    io.to(`user:${toUserId}`).emit(event, data);
  } else {
    console.log(`📢 API Broadcasting '${event}'`);
    io.emit(event, data);
  }

  res.json({ success: true });
});

server.listen(PORT, () => {
  console.log(`🚀 Socket.IO Server running on port ${PORT}`);
  console.log(`👉 API Endpoint: http://localhost:${PORT}/api/broadcast`);
});
