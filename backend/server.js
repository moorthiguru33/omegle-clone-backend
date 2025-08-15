const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Simple CORS configuration
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

// Simple Queue Class
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
        this.io = io;
        this.queue = new Queue();
        this.userCount = 0;
    }

    async addUser(socketId) {
        // Add small delay like friend's app
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        this.userCount++;
        console.log(`User ${socketId} added. Total users: ${this.userCount}`);
        
        this.queue.enqueue({ id: socketId });
        console.log(`Queue size: ${this.queue.size()}`);

        // Try to match users
        if (this.queue.size() >= 2) {
            console.log("Pair found!");
            const user1 = this.queue.dequeue();
            const user2 = this.queue.dequeue();

            if (user1 && user2) {
                const roomId = this.createRoom(user1, user2);
                this.io.to(user1.id).to(user2.id).emit('joined', { room: roomId });
                this.io.to(user1.id).emit('send-offer');
                console.log(`Room ${roomId} created for ${user1.id} and ${user2.id}`);
            }
        } else {
            console.log("No pair found, user waiting in queue");
        }

        this.io.emit('user-count', this.userCount);
    }

    createRoom(user1, user2) {
        const roomId = uuidv4();
        this.rooms.set(roomId, { user1, user2 });
        return roomId;
    }

    handleOffer(socketId, roomId, offer) {
        console.log(`Offer from ${socketId} for room ${roomId}`);
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        console.log(`Sending offer to ${receiver}`);
        this.io.to(receiver).emit('offer', offer);
    }

    handleAnswer(socketId, roomId, answer) {
        console.log(`Answer from ${socketId} for room ${roomId}`);
        const room = this.rooms.get(roomId);
        if (!room) return;

        const receiver = room.user1.id === socketId ? room.user2.id : room.user1.id;
        console.log(`Sending answer to ${receiver}`);
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
        console.log(`User ${socketId} disconnected`);
        
        // Remove from queue
        const itemToRemove = this.queue.find(socketId);
        if (itemToRemove) {
            this.queue.remove(itemToRemove);
            console.log(`Removed ${socketId} from queue`);
        }

        this.userCount--;

        // Handle room cleanup
        this.rooms.forEach((room, roomId) => {
            if (room.user1.id === socketId || room.user2.id === socketId) {
                console.log(`Cleaning up room ${roomId}`);
                this.rooms.delete(roomId);
                this.io.to(room.user1.id).to(room.user2.id).emit('leaveRoom');
            }
        });

        this.io.emit('user-count', this.userCount);
    }

    handleLeaveRoom(socketId) {
        console.log(`Leave room request from ${socketId}`);
        this.rooms.forEach((room, roomId) => {
            if (room.user1.id === socketId || room.user2.id === socketId) {
                this.rooms.delete(roomId);
                this.io.to(room.user1.id).to(room.user2.id).emit('leaveRoom');
            }
        });
    }
}

const roomManager = new RoomManager(io);

// Socket connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join', () => {
        console.log(`User joined: ${socket.id}`);
        roomManager.addUser(socket.id);
    });

    socket.on('offer', (roomId, offer) => {
        roomManager.handleOffer(socket.id, roomId, offer);
    });

    socket.on('answer', (roomId, answer) => {
        roomManager.handleAnswer(socket.id, roomId, answer);
    });

    socket.on('ice-candidates', (roomId, iceCandidate) => {
        roomManager.handleIceCandidates(socket.id, roomId, iceCandidate);
    });

    socket.on('message', (roomId, message) => {
        roomManager.handleMessage(roomId, socket.id, message);
    });

    socket.on('leaveRoom', () => {
        roomManager.handleLeaveRoom(socket.id);
    });

    socket.on('disconnect', () => {
        roomManager.handleDisconnect(socket.id);
    });
});

// Simple health check
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
    console.log(`Server running on port ${PORT}`);
});
