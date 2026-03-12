const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const supabase = require('./db.cjs'); // Import Supabase Client

const app = express();
const path = require('path');
app.use(cors());
app.use(express.static(__dirname));

// --- Pretty URLs ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/gps', (req, res) => res.sendFile(path.join(__dirname, 'gps.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, 'superadmin.html')));
app.get('/index', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Operation Management ---
    const SUPER_ADMIN_KEY = "Cclass2022***";

    socket.on('login-super-admin', ({ key }) => {
        if (key === SUPER_ADMIN_KEY) {
            socket.emit('super-admin-auth', { success: true });
        } else {
            socket.emit('super-admin-auth', { success: false, msg: "Invalid Master Key" });
        }
    });

    socket.on('create-tenant', async ({ key, opId, password }) => {
        if (key !== SUPER_ADMIN_KEY) {
            return socket.emit('tenant-created', { success: false, msg: "Unauthorized" });
        }

        // Check if exists
        const { data: existing } = await supabase.from('operations').select('id').eq('id', opId).single();
        if (existing) {
            return socket.emit('tenant-created', { success: false, msg: "Operation ID already exists." });
        }

        // Create Operation
        const { error: opError } = await supabase.from('operations').insert([{ id: opId, admin_password: password }]);
        if (opError) {
            console.error("Create Op Error:", opError);
            return socket.emit('tenant-created', { success: false, msg: "Database Error" });
        }

        // Create Default Channels
        const defaultChannels = [
            { op_id: opId, name: 'CHANNEL 1' },
            { op_id: opId, name: 'LOGISTICS' }
        ];
        await supabase.from('channels').insert(defaultChannels);

        // Generate initial invite token
        const token = Math.random().toString(36).substring(2, 10);
        await supabase.from('operation_tokens').insert([{ token, op_id: opId }]);

        console.log(`[SUPER ADMIN] Tenant created: ${opId}`);
        socket.emit('tenant-created', { opId, success: true, token });
    });

    socket.on('list-tenants', async ({ key }) => {
        if (key !== SUPER_ADMIN_KEY) return;
        const { data, error } = await supabase.from('operations').select('id, admin_password');
        if (!error) {
            socket.emit('tenants-list', data.map(op => ({ opId: op.id, adminPass: op.admin_password })));
        }
    });

    socket.on('login-admin', async ({ opId, password }) => {
        const { data: op, error } = await supabase.from('operations').select('*').eq('id', opId).single();

        if (op && op.admin_password === password) {
            socket.join(`admin-${opId}`);
            socket.AdminOpId = opId;

            // Fetch Channels
            const { data: channels } = await supabase.from('channels').select('name').eq('op_id', opId);
            const channelList = channels ? channels.map(c => c.name) : [];

            // Fetch Active Units
            const { data: units } = await supabase.from('units').select('*').eq('op_id', opId).neq('status', 'OFFLINE');
            const activeUnits = {};
            if (units) {
                units.forEach(u => {
                    activeUnits[u.socket_id] = {
                        id: u.id,
                        callSign: u.callsign, // Map to camelCase
                        lat: u.lat,
                        lng: u.lng,
                        status: u.status,
                        lastSeen: u.last_seen,
                        socketId: u.socket_id
                    };
                });
            }

            socket.emit('admin-authenticated', { success: true, opId, channels: channelList });
            socket.emit('active-units-list', activeUnits);
        } else {
            socket.emit('admin-auth-error', 'Invalid credentials');
        }
    });

    socket.on('generate-invite', async ({ opId }) => {
        const token = Math.random().toString(36).substring(2, 10);
        const { error } = await supabase.from('operation_tokens').insert([{ token, op_id: opId }]);
        if (!error) {
            socket.emit('invite-generated', { token, opId });
        }
    });

    // --- Channel Management ---
    const fusionMap = {}; // Maps `${opId}-${subId}` -> masterId

    socket.on('fuse-incidents', async ({ masterId, subIds }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: masterId }]);
        if (!error) {
            notifyChannelsUpdated(opId);

            subIds.forEach(subId => {
                fusionMap[`${opId}-${subId}`] = masterId;
                // Move everyone currently in subId room to masterId
                const subRoomName = `${opId}-${subId}`;
                const clients = io.sockets.adapter.rooms.get(subRoomName);
                if (clients) {
                    for (const clientId of clients) {
                        io.to(clientId).emit('force-join-channel', masterId);
                    }
                }

                io.to(`admin-${opId}`).emit('incident-fused', { masterId, subIds });
            });
        }
    });

    socket.on('add-channel', async ({ channelName }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: channelName }]);
        if (!error) {
            notifyChannelsUpdated(opId);
        }
    });

    socket.on('assign-to-incident', ({ incidentId, unitSocketId }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        // Force the assigned unit to join the incident channel
        io.to(unitSocketId).emit('force-join-channel', incidentId);

        // Also force the admin to join the incident channel so they can talk
        socket.emit('force-join-channel', incidentId);
    });

    socket.on('create-tactical-zone', async ({ channelName, unitSocketIds }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        // 1. Create the ephemeral channel in DB
        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: channelName }]);

        if (!error) {
            notifyChannelsUpdated(opId);

            // 2. Force all selected units into this channel
            unitSocketIds.forEach(targetId => {
                io.to(targetId).emit('force-join-channel', channelName);
            });

            // 3. Force Admin into the channel
            socket.emit('force-join-channel', channelName);

            // 4. Auto-destruct after 5 minutes (300000 ms) of inactivity
            // In a real app we'd reset this timer on audio activity, but for now a fixed TTL
            setTimeout(async () => {
                const { error: delErr } = await supabase.from('channels').delete().match({ op_id: opId, name: channelName });
                if (!delErr) {
                    notifyChannelsUpdated(opId);
                    // Force remaining users in this room back to BASE
                    io.to(`${opId}-${channelName}`).emit('force-join-channel', 'BASE');
                }
            }, 300000);
        }
    });

    socket.on('remove-channel', async ({ channelName }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').delete().match({ op_id: opId, name: channelName });
        if (!error) {
            notifyChannelsUpdated(opId);
        }
    });

    async function notifyChannelsUpdated(opId) {
        const { data: channels } = await supabase.from('channels').select('name').eq('op_id', opId);
        const list = channels.map(c => c.name);

        let defaultChannel = 'BASE';
        if (channels && channels.length > 0) {
            const hasBase = channels.some(c => c.name === 'BASE');
            if (!hasBase) defaultChannel = channels[0].name;
        }

        io.to(`admin-${opId}`).emit('channels-updated', list);
        io.to(opId).emit('operation-config', { channels: list, opId, defaultChannel });
    }

    // --- User Logic ---

    socket.on('join-operation', async ({ opId, token, userId, callSign }) => {
        // Validation (Optional: Check token in operation_tokens)
        const { data: op } = await supabase.from('operations').select('id').eq('id', opId).single();
        if (!op) return socket.emit('join-error', 'Operation not found');

        socket.join(opId);
        socket.OpId = opId;
        socket.UserId = userId; // Track user ID

        // Get Channels
        const { data: channels } = await supabase.from('channels').select('name').eq('op_id', opId);

        let defaultChannel = 'BASE';
        if (channels && channels.length > 0) {
            const hasBase = channels.some(c => c.name === 'BASE');
            if (!hasBase) defaultChannel = channels[0].name;
        }

        socket.emit('operation-config', {
            channels: channels.map(c => c.name),
            opId,
            defaultChannel
        });

        // Register Unit
        const unitData = {
            id: userId,
            op_id: opId,
            callsign: callSign,
            socket_id: socket.id,
            status: "WAITING FOR GPS...",
            last_seen: new Date().toISOString()
        };

        await supabase.from('units').upsert(unitData);

        // Notify Admin with camelCase
        io.to(`admin-${opId}`).emit('register-unit', {
            id: userId,
            callSign: callSign,
            socketId: socket.id,
            status: "WAITING FOR GPS...",
            lat: 0,
            lng: 0,
            lastSeen: unitData.last_seen
        });
    });

    socket.on('join-channel', ({ opId, channelName }) => {
        if (socket.OpId !== opId) return;

        let targetChannel = channelName;
        // Redirect if fused
        if (fusionMap[`${opId}-${channelName}`]) {
            targetChannel = fusionMap[`${opId}-${channelName}`];
            socket.emit('force-join-channel', targetChannel);
            return;
        }

        // Leave previous channel
        if (socket.CurrentChannel) {
            const oldRoom = `${opId}-${socket.CurrentChannel}`;
            socket.leave(oldRoom);
            const oldRoomSize = io.sockets.adapter.rooms.get(oldRoom)?.size || 0;
            io.to(oldRoom).emit('channel-users-count', oldRoomSize);
        }

        socket.CurrentChannel = channelName;
        const newRoom = `${opId}-${channelName}`;
        socket.join(newRoom);
        socket.to(newRoom).emit('user-connected', socket.id);

        const newRoomSize = io.sockets.adapter.rooms.get(newRoom)?.size || 0;
        io.to(newRoom).emit('channel-users-count', newRoomSize);
    });

    socket.on('leave-room', (channelName) => {
        const opId = socket.OpId;
        if (!opId) return;
        const roomName = `${opId}-${channelName}`;
        socket.leave(roomName);
        if (socket.CurrentChannel === channelName) {
            socket.CurrentChannel = null;
        }
        const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 0;
        io.to(roomName).emit('channel-users-count', roomSize);
    });

    // --- GPS Logic ---

    socket.on('update-location', async (data) => {
        const opId = socket.OpId;
        if (!opId) return;

        const updateData = {
            lat: data.lat,
            lng: data.lng, // Fix: data.lng (client sends lng)
            status: "ACTIVE",
            last_seen: new Date().toISOString(),
            socket_id: socket.id
        };

        // Update DB
        await supabase.from('units').update(updateData).eq('id', data.id);

        // Propagate to Admin
        io.to(`admin-${opId}`).emit('update-location', { ...data, socketId: socket.id, status: "ACTIVE" });
    });

    socket.on('sos-alert', async ({ lat, lng }) => {
        const opId = socket.OpId;
        if (!opId) return;

        const sosTicket = `SOS-TICKET-${socket.UserId || Date.now().toString().slice(-4)}`;

        // Insert channel
        await supabase.from('channels').insert([{ op_id: opId, name: sosTicket }]);

        notifyChannelsUpdated(opId);

        io.to(socket.id).emit('force-join-channel', sosTicket);

        io.to(`admin-${opId}`).emit('sos-triggered', {
            userId: socket.UserId,
            channelName: sosTicket,
            lat,
            lng
        });
    });

    // --- WebRTC ---
    socket.on('offer', (data) => {
        console.log(`[WEBRTC] Offer from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('offer', { offer: data.offer, caller: socket.id });
    });
    socket.on('answer', (data) => {
        console.log(`[WEBRTC] Answer from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('answer', { answer: data.answer, caller: socket.id });
    });
    socket.on('ice-candidate', (data) => {
        // console.log(`[WEBRTC] ICE from ${socket.id} to ${data.target}`);
        io.to(data.target).emit('ice-candidate', { candidate: data.candidate, caller: socket.id });
    });

    socket.on('disconnect', async () => {
        const opId = socket.OpId;
        if (opId) {
            if (socket.CurrentChannel) {
                const roomName = `${opId}-${socket.CurrentChannel}`;
                const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 0;
                io.to(roomName).emit('channel-users-count', roomSize);
            }

            // Mark as Offline
            if (socket.UserId) {
                await supabase.from('units').update({ status: 'OFFLINE', socket_id: null }).eq('id', socket.UserId);
            }
            io.to(`admin-${opId}`).emit('user-disconnected', socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

// --- Chaos Index Evaluator ---
const operationChaosScores = {};

setInterval(() => {
    const activeOpIds = new Set();
    for (const [room, _] of io.sockets.adapter.rooms.entries()) {
        if (room.startsWith('admin-')) {
            activeOpIds.add(room.replace('admin-', ''));
        }
    }

    activeOpIds.forEach(opId => {
        let rawScore = 0;
        let activeIncidents = 0;
        let sosAlerts = 0;
        let busyOperators = 0;

        const rooms = io.sockets.adapter.rooms;
        for (const [room, clients] of rooms.entries()) {
            if (room.startsWith(`${opId}-`)) {
                const channelName = room.replace(`${opId}-`, '');

                let opCount = 0;
                clients.forEach(socketId => {
                    const s = io.sockets.sockets.get(socketId);
                    if (s && s.UserId) opCount++;
                });

                if (channelName.startsWith('INCIDENT-')) {
                    activeIncidents++;
                    rawScore += 15;
                } else if (channelName.startsWith('SOS-')) {
                    sosAlerts++;
                    rawScore += 30;
                }

                if (channelName !== 'BASE' && channelName !== 'LOGISTICS') {
                    busyOperators += opCount;
                    rawScore += opCount * 3;
                }
            }
        }

        if (!operationChaosScores[opId]) {
            operationChaosScores[opId] = { currentScore: 0 };
        }

        // Cap
        let targetScore = Math.min(rawScore, 100);

        // Hysteresis
        const prevScore = operationChaosScores[opId].currentScore;
        const smoothScore = (prevScore * 0.8) + (targetScore * 0.2);
        operationChaosScores[opId].currentScore = smoothScore;

        let index = Math.round(smoothScore);
        let state = "BAJO";
        if (index >= 75) state = "CRÍTICO";
        else if (index >= 50) state = "ALTO";
        else if (index >= 25) state = "MEDIO";

        io.to(`admin-${opId}`).emit('chaos-index-updated', { index, state });
    });
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
