const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Simple CORS setup
app.use(cors({
    origin: [
        "https://lambent-biscuit-2313da.netlify.app",
        "http://localhost:3000",
        "https://localhost:3000"
    ],
    credentials: true,
    methods: ["GET", "POST"]
}));

const io = socketIo(server, {
    cors: {
        origin: [
            "https://lambent-biscuit-2313da.netlify.app",
            "http://localhost:3000"
        ],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Simple Queue Implementation
class Queue {
    constructor() {
        this.storage = [];
    }

    enqueue(item) {
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
}

// Simple Room Manager
class RoomManager {
    constructor(io) {
        this.rooms = new Map();
        this.queue = new Queue();
        this.io = io;
        this.userCount = 0;
    }

    async addUser(socketId) {
        // Small delay like friend's app for stability
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        this.userCount++;
        console.log(`User ${socketId} joined. Total: ${this.userCount}`);
        
        this.queue.enqueue({ id: socketId });
        console.log(`Queue size: ${this.queue.size()}`);

        if (this.queue.size() >= 2) {
            console.log(":: Pair found ::");
            const user1 = this.queue.dequeue();
            const user2 = this.queue.dequeue();

            if (user1 && user2) {
                const roomId = this.createRoom(user1, user2);
                this.io.to(user1.id).to(user2.id).emit('joined', { room: roomId });
                this.io.to(user1.id).emit('send-offer');
                console.log(`Room ${roomId} created for ${user1.id} and ${user2.id}`);
            }
        } else {
            console.log("NO PAIR FOUND - User waiting");
        }

        this.io.emit('user-count', this.userCount);
    }

    createRoom(user1, user2) {
        const roomId = uuidv4();
        this.rooms.set(roomId, { user1, user2 });
        return roomId;
    }

    handleOffer(socketId, roomId, offer) {
        console.log(`OFFER from ${socketId} for room ${roomId}`);
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        console.log(`SENDING OFFER TO ${receiver}`);
        this.io.to(receiver).emit('offer', offer);
    }

    handleAnswer(socketId, roomId, answer) {
        console.log(`ANSWER from ${socketId} for room ${roomId}`);
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        console.log(`SENDING ANSWER TO ${receiver}`);
        this.io.to(receiver).emit('answer', answer);
    }

    handleIceCandidates(socketId, roomId, iceCandidate) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        this.io.to(receiver).emit('ice-candidates', iceCandidate);
    }

    handleMessage(roomId, socketId, message) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        this.io.to(receiver).emit('message', message);
    }

    handleDisconnect(socketId) {
        console.log(`DISCONNECTED: ${socketId}`);
        
        // Remove from queue
        const itemToRemove = this.queue.find(socketId);
        if (itemToRemove) {
            this.queue.remove(itemToRemove);
            console.log(`Removed ${socketId} from queue`);
        }

        this.userCount--;

        // Clean up rooms
        this.rooms.forEach((room, roomId) => {
            if (room.user1.id === socketId || room.user2.id === socketId) {
                console.log(`DELETING ROOM: ${roomId}`);
                this.rooms.delete(roomId);
                this.io.to(room.user1.id).to(room.user2.id).emit('leaveRoom');
            }
        });

        this.io.emit('user-count', this.userCount);
    }

    handleLeaveRoom(socketId) {
        console.log(`LEAVE ROOM REQUEST FROM: ${socketId}`);
        this.rooms.forEach((room, roomId) => {
            if (room.user1.id === socketId || room.user2.id === socketId) {
                this.rooms.delete(roomId);
                console.log(`DELETING ROOM: ${roomId}`);
                this.io.to(room.user1.id).to(room.user2.id).emit('leaveRoom');
            }
        });
    }
}

const roomManager = new RoomManager(io);

// Socket Connection Handling
io.on('connection', (socket) => {
    console.log(`user connected: ${socket.id}`);

    socket.on('join', () => {
        console.log(`user joined: ${socket.id}`);
        roomManager.addUser(socket.id);
    });

    socket.on('disconnect', () => {
        console.log(`user disconnected: ${socket.id}`);
        roomManager.handleDisconnect(socket.id);
    });

    socket.on('message', (roomId, message) => {
        roomManager.handleMessage(roomId, socket.id, message);
    });

    socket.on('offer', (roomId, offer) => {
        console.log('offer received');
        roomManager.handleOffer(socket.id, roomId, offer);
    });

    socket.on('answer', (roomId, answer) => {
        console.log('answer received');
        roomManager.handleAnswer(socket.id, roomId, answer);
    });

    socket.on('ice-candidates', (roomId, iceCandidate) => {
        console.log('ice-candidates received');
        roomManager.handleIceCandidates(socket.id, roomId, iceCandidate);
    });

    socket.on('leaveRoom', () => {
        console.log(`LEAVE ROOM REQUEST FROM ${socket.id}`);
        roomManager.handleLeaveRoom(socket.id);
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'OmeLive Server Online',
        users: roomManager.userCount,
        rooms: roomManager.rooms.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`listening on port: ${PORT}`);
});
