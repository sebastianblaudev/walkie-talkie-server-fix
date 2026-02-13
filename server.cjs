const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const supabase = require('./db'); // Import Supabase Client

const app = express();
const path = require('path');
app.use(cors());
app.use(express.static(__dirname));

// --- Pretty URLs ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/gps', (req, res) => res.sendFile(path.join(__dirname, 'gps.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, 'superadmin.html')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Operation Management ---
    const SUPER_ADMIN_KEY = "omega-level-access";

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

        console.log(`[SUPER ADMIN] Tenant created: ${opId}`);
        socket.emit('tenant-created', { opId, success: true });
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

    socket.on('add-channel', async ({ channelName }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: channelName }]);
        if (!error) {
            notifyChannelsUpdated(opId);
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
        io.to(`admin-${opId}`).emit('channels-updated', list);
        io.to(opId).emit('operation-config', { channels: list, opId });
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
        socket.emit('operation-config', {
            channels: channels.map(c => c.name),
            opId
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
        socket.join(`${opId}-${channelName}`);
        socket.to(`${opId}-${channelName}`).emit('user-connected', socket.id);
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
        // We use map to match 'id' which is the primary key (userId)
        // But wait, 'units' table PK is 'id' (userId).
        // upsert needs primary key.
        // We need to make sure we have the userId. It's in 'data.id' from client usually?
        // Client app.js: socket.emit('update-location', { lat, lng, id: uid, callSign: csign });

        await supabase.from('units').update(updateData).eq('id', data.id);

        // Propagate to Admin
        io.to(`admin-${opId}`).emit('update-location', { ...data, socketId: socket.id, status: "ACTIVE" });
    });

    // --- WebRTC ---
    socket.on('offer', (data) => io.to(data.target).emit('offer', { offer: data.offer, caller: socket.id }));
    socket.on('answer', (data) => io.to(data.target).emit('answer', { answer: data.answer, caller: socket.id }));
    socket.on('ice-candidate', (data) => io.to(data.target).emit('ice-candidate', { candidate: data.candidate, caller: socket.id }));

    socket.on('disconnect', async () => {
        const opId = socket.OpId;
        if (opId) {
            // Mark as Offline
            if (socket.UserId) {
                await supabase.from('units').update({ status: 'OFFLINE', socket_id: null }).eq('id', socket.UserId);
            }
            io.to(`admin-${opId}`).emit('user-disconnected', socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
