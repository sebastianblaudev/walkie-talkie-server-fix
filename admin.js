
const socket = io(); // Auto-connect to origin

// State
let currentOpId = '';
let currentToken = '';
let map = null;
let units = {}; // socketId -> unitData

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard-container');
const loginBtn = document.getElementById('login-btn');
const opIdInput = document.getElementById('op-id-input');
const opPassInput = document.getElementById('op-pass-input');
const loginError = document.getElementById('login-error');
const createToggle = document.getElementById('create-toggle');
const displayOpId = document.getElementById('display-op-id');
const channelList = document.getElementById('channel-list');
const addChannelBtn = document.getElementById('add-channel-btn');
const newChannelInput = document.getElementById('new-channel-name');
const inviteBtn = document.getElementById('generate-invite-btn');
const activeUnitCount = document.getElementById('active-unit-count');

// --- Login / Create Logic ---

// --- Login Logic ---

// Removed Create Mode Toggle


loginBtn.addEventListener('click', () => {
    const opId = opIdInput.value.trim();
    const password = opPassInput.value.trim();

    if (!opId || !password) {
        showError("Credentials required.");
        return;
    }

    socket.emit('login-admin', { opId, password });
});

function showError(msg) {
    loginError.innerText = msg;
    loginError.style.display = 'block';
}

// --- Socket Handlers ---

socket.on('operation-created', ({ success, opId }) => {
    if (success) {
        // Auto-login after create
        const password = opPassInput.value.trim();
        socket.emit('login-admin', { opId, password });
    }
});

socket.on('operation-error', (msg) => {
    showError(msg);
});

socket.on('admin-auth-error', (msg) => {
    showError(msg);
});

socket.on('admin-authenticated', ({ success, opId, channels }) => {
    if (success) {
        // Save credentials for GPS view and reload
        localStorage.setItem('admin_op_id', opId);
        // We need to capture password from input or closure if not provided in event
        // But the event doesn't return it. We can grab it from logic above or input
        // Since this listener runs after login request, inputs might still be populated
        const password = document.getElementById('op-pass-input').value.trim();
        if (password) localStorage.setItem('admin_op_pass', password);

        currentOpId = opId;
        loginScreen.style.opacity = '0';
        setTimeout(() => loginScreen.style.display = 'none', 500);

        dashboard.classList.add('active');
        displayOpId.innerText = opId.toUpperCase();

        renderChannels(channels);
        initMap();
    }
});


// --- Dashboard Logic ---

// Channels
function renderChannels(channels) {
    channelList.innerHTML = '';
    channels.forEach(channel => {
        const div = document.createElement('div');
        div.className = 'channel-item';
        div.innerHTML = `
            <span># ${channel}</span>
            <button class="btn-icon material-icons-round" onclick="removeChannel('${channel}')">delete</button>
        `;
        channelList.appendChild(div);
    });
}

// Add Channel
addChannelBtn.addEventListener('click', () => {
    const channelName = newChannelInput.value.trim().toUpperCase();
    if (!channelName) return;

    socket.emit('add-channel', { channelName });
    newChannelInput.value = '';
});

// Remove Channel
window.removeChannel = (channelName) => {
    if (confirm(`Delete channel ${channelName}?`)) {
        socket.emit('remove-channel', { channelName });
    }
};

socket.on('channels-updated', (channels) => {
    renderChannels(channels);
});

// Invite
inviteBtn.addEventListener('click', () => {
    socket.emit('generate-invite', { opId: currentOpId });
});

socket.on('invite-generated', ({ token, opId }) => {
    const url = `${window.location.origin}/?op=${opId}&token=${token}`;
    navigator.clipboard.writeText(url).then(() => {
        const originalText = inviteBtn.innerText;
        inviteBtn.innerText = "COPIED TO CLIPBOARD!";
        setTimeout(() => inviteBtn.innerText = originalText, 2000);
    });
});

// --- Map & GPS Logic ---

function initMap() {
    map = L.map('admin-map').setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
}

socket.on('active-units-list', (list) => {
    // Initial bulk load
    units = {};
    if (map) {
        map.eachLayer((layer) => {
            if (layer instanceof L.Marker) map.removeLayer(layer);
        });
    }
    Object.values(list).forEach(data => updateUnitMarker(data));
    updateCount();
});

socket.on('update-location', (data) => {
    updateUnitMarker(data);
    updateCount();
});

socket.on('register-unit', (data) => {
    updateUnitMarker(data);
    updateCount();
});

socket.on('user-disconnected', (socketId) => {
    if (units[socketId]) {
        if (units[socketId].marker) units[socketId].marker.remove();
        delete units[socketId];
        updateCount();
    }
});

function updateUnitMarker(data) {
    // data = { socketId, id, callSign, lat, lng }
    let unit = units[data.socketId];

    if (!unit) {
        units[data.socketId] = { ...data, marker: null };
        unit = units[data.socketId];
    }

    // Update data
    Object.assign(unit, data);

    if (unit.lat && unit.lng && map) {
        if (!unit.marker) {
            const color = getColorForUnit(unit.callSign);
            const markerIcon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div style="background-color:${color}; width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 10px ${color}; border: 2px solid #fff;"></div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });
            unit.marker = L.marker([unit.lat, unit.lng], { icon: markerIcon }).addTo(map);
            unit.marker.bindPopup(`<b>${unit.callSign}</b><br>ID: ${unit.id}`);

            // Auto zoom valid point if map at world view
            if (map.getZoom() < 5) map.setView([unit.lat, unit.lng], 15);
        } else {
            unit.marker.setLatLng([unit.lat, unit.lng]);
        }
    }
}

// DOM Elements
const unitsList = document.getElementById('units-list');

function updateCount() {
    activeUnitCount.innerText = Object.keys(units).length;
    renderUnitsList();
}

function renderUnitsList() {
    if (!unitsList) return;
    unitsList.innerHTML = '';

    if (Object.keys(units).length === 0) {
        unitsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #444; font-size: 12px;">WAITING FOR SIGNALS...</div>';
        return;
    }

    Object.values(units).forEach(unit => {
        const div = document.createElement('div');
        div.className = 'unit-item';

        let statusColor = '#555';
        if (unit.lat && unit.lng) statusColor = '#50E3C2'; // Green if GPS fix

        div.innerHTML = `
            <div class="u-dot" style="background: ${statusColor}; box-shadow: 0 0 5px ${statusColor};"></div>
            <div class="u-info">
                <span class="u-name">${unit.callSign}</span>
                <span class="u-status" style="font-size: 9px;">${unit.status || 'NO DATA'}</span>
            </div>
            <span class="material-icons-round" style="margin-left: auto; font-size: 16px; color: #555;">my_location</span>
        `;

        div.addEventListener('click', () => {
            if (unit.lat && unit.lng && map) {
                map.flyTo([unit.lat, unit.lng], 16, {
                    animate: true,
                    duration: 1.5
                });
                // Highlight marker?
                if (unit.marker) {
                    unit.marker.openPopup();
                }
            } else {
                alert("NO WR: Unit has no GPS fix yet.");
            }
        });

        unitsList.appendChild(div);
    });
}

function getColorForUnit(name) {
    const colors = ['#50E3C2', '#5097E3', '#FF9F0A', '#FF5E57', '#D1E350'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}
