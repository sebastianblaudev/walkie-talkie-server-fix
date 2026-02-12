const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        // Broadcast to others in the room
        socket.to(roomId).emit('user-connected', socket.id);
    });

    socket.on('offer', (data) => {
        console.log(`Offer from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('offer', {
            offer: data.offer,
            caller: socket.id
        });
    });

    socket.on('answer', (data) => {
        console.log(`Answer from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('answer', {
            answer: data.answer,
            caller: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        console.log(`ICE from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            caller: socket.id
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        io.emit('user-disconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
