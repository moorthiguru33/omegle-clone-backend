const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CORS configuration
const allowedOrigins = [
  "https://lambent-biscuit-2313da.netlify.app",
  "http://localhost:3000",
  "https://localhost:3000",
  /\.netlify\.app$/,
  /localhost:\d+$/,
  process.env.FRONTEND_URL,
  "*" // Allow all origins for development
].filter(Boolean);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true,
}));

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Queue implementation (from Queue.ts)
class Queue {
  constructor(capacity = Infinity) {
    this.storage = [];
    this.capacity = capacity;
  }

  enqueue(item) {
    if (this.size() === this.capacity) {
      throw new Error("Queue has reached max capacity, you cannot add more items");
    }
    this.storage.push(item);
  }

  dequeue() {
    return this.storage.shift();
  }

  size() {
    return this.storage.length;
  }

  remove(item) {
    const index = this.storage.findIndex(elem => elem.id === item.id);
    if (index !== -1) {
      this.storage.splice(index, 1);
    }
  }

  find(id) {
    return this.storage.find(item => item.id === id);
  }

  printQueue() {
    console.log("Current Queue:");
    console.log(this.storage);
  }
}

// Room Manager (from Room.ts)
class RoomManager {
  constructor(io) {
    this.rooms = new Map();
    this.io = io;
    this.queue = new Queue();
    this.numOfPlayers = 0;
  }

  createRoom(user1, user2) {
    const roomId = uuidv4();
    this.rooms.set(roomId, { user1, user2 });
    return roomId;
  }

  async addUser(socketId) {
    // Add 3-second delay like reference code to prevent rapid connections
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    this.numOfPlayers++;
    console.log(`Number of players --> ${socketId} => ${this.numOfPlayers}`);
    
    this.queue.enqueue({ id: socketId });
    console.log(`PLAYERS IN QUEUE -> ${this.queue.size()}`);
    
    if (this.queue.size() > 1) {
      console.log(":: Pair found ::");
      const user1 = this.queue.dequeue();
      const user2 = this.queue.dequeue();
      
      if (user1 && user2) {
        console.log("requesting offer");
        const room = this.createRoom(user1, user2);
        
        // Notify both users they joined a room
        this.io.to(user1.id).to(user2.id).emit('joined', { room });
        
        // Request the first user to send offer (critical for connection flow)
        this.io.to(user1.id).emit("send-offer");
        console.log(`sent offer request to :: ${user1.id}`);
      }
    } else {
      console.log("NO PAIR FOUND");
    }
    
    // Broadcast user count to all clients
    this.io.emit("user-count", this.numOfPlayers);
  }

  handleOffer(socketId, roomId, offer) {
    console.log(`OFFER SENT BY :: ${socketId} FOR ROOM :: ${roomId}`);
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
    console.log(`SENDING OFFER TO :: ${receiver}`);
    this.io.to(receiver).emit("offer", offer);
  }

  handleAnswer(socketId, roomId, answer) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
    console.log(`RECEIVED ANSWER SENDING TO :: ${receiver}`);
    this.io.to(receiver).emit("answer", answer);
  }

  handleIceCandidates(socketId, roomId, iceCandidates) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
    this.io.to(receiver).emit("ice-candidates", iceCandidates);
  }

  handleDisconnect(socketId) {
    console.log(`DISCONNECTED :: ${socketId}`);
    
    // Remove from queue
    const itemToRemove = this.queue.find(socketId);
    this.numOfPlayers--;
    this.queue.printQueue();
    
    if (itemToRemove) {
      this.queue.remove(itemToRemove);
      console.log(`Removed item with id ${socketId}.`);
    }
    
    this.queue.printQueue();
    
    // Handle room cleanup
    this.rooms.forEach((room, roomId) => {
      console.log(`ROOM :: ${roomId} USER1 :: ${room.user1.id} USER2 :: ${room.user2.id}`);
      if (room.user1.id === socketId || room.user2.id === socketId) {
        this.rooms.delete(roomId);
        console.log(`DELETING ROOM :: ${roomId}`);
        this.io.to(room.user1.id).to(room.user2.id).emit("leaveRoom");
      }
    });
    
    this.io.emit("user-count", this.numOfPlayers);
  }

  handleLeaveRoom(socketId) {
    console.log(`LEAVING REQUEST FROM :: ${socketId}`);
    
    this.rooms.forEach((room, roomId) => {
      console.log(`ROOM :: ${roomId} USER1 :: ${room.user1.id} USER2 :: ${room.user2.id}`);
      if (room.user1.id === socketId || room.user2.id === socketId) {
        this.rooms.delete(roomId);
        console.log(`DELETING ROOM :: ${roomId}`);
        this.io.to(room.user1.id).to(room.user2.id).emit("leaveRoom");
      }
    });
  }

  handleMessage(roomId, socketId, message) {
    console.log(`MESSAGE RECEIVED IN :: ${roomId}`);
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
    this.io.to(receiver).emit("message", message);
  }
}

const manager = new RoomManager(io);

// Socket connection handling (from index.ts)
io.on('connection', (socket) => {
  console.log(`user connected :: ${socket.id}`);

  socket.on("join", () => {
    console.log(`user joined :: ${socket.id}`);
    manager.addUser(socket.id);
  });

  socket.on("disconnect", () => {
    console.log(`user disconnected :: ${socket.id}`);
    manager.handleDisconnect(socket.id);
  });

  socket.on("message", (roomId, message) => {
    manager.handleMessage(roomId, socket.id, message);
  });

  socket.on("offer", (roomId, offer) => {
    console.log("offer ->");
    manager.handleOffer(socket.id, roomId, offer);
  });

  socket.on("answer", (roomId, answer) => {
    console.log("answer ->");
    manager.handleAnswer(socket.id, roomId, answer);
  });

  socket.on("ice-candidates", (roomId, iceCandidates) => {
    console.log("iceCandidates ->");
    manager.handleIceCandidates(socket.id, roomId, iceCandidates);
  });

  socket.on("leaveRoom", (roomId) => {
    console.log(`LEAVE ROOM REQUEST FROM ${socket.id}`);
    manager.handleLeaveRoom(socket.id);
  });
});

// API Routes
app.get('/', (req, res) => {
  return res.json({
    status: "OmeLive Server - ONLINE",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    activeUsers: manager.numOfPlayers,
    queueSize: manager.queue.size(),
    activeRooms: manager.rooms.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    activeUsers: manager.numOfPlayers,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on *: ${PORT}`);
});

module.exports = { app, server, io, manager };
