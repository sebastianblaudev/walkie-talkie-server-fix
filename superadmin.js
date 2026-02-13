
const socket = io();

// State
let masterToken = '';

// DOM Elements
const loginDiv = document.getElementById('super-login');
const dashDiv = document.getElementById('super-dashboard');
const masterKeyInput = document.getElementById('master-key');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const createOpBtn = document.getElementById('create-op-btn');
const newOpIdInput = document.getElementById('new-op-id');
const newOpPassInput = document.getElementById('new-op-pass');
const createMsg = document.getElementById('create-msg');

const opList = document.getElementById('op-list');
const refreshBtn = document.getElementById('refresh-btn');

// --- Login ---

loginBtn.addEventListener('click', () => {
    const key = masterKeyInput.value.trim();
    if (!key) return;

    console.log('Attempting Super Admin Login with key:', key);
    if (!socket.connected) {
        alert('Error: No connection to server. Please check if server is running.');
        return;
    }

    socket.emit('login-super-admin', { key });
});

socket.on('connect', () => {
    console.log('Connected to server via Socket.IO');
});

socket.on('super-admin-auth', ({ success, msg, token }) => {
    console.log('Auth Response:', { success, msg });
    if (success) {
        masterToken = token; // Currently just reusing the key or a session token if server provided one
        loginDiv.style.display = 'none';
        dashDiv.style.display = 'block';
        fetchOperations();
    } else {
        loginError.innerText = msg || 'Auth Failed';
        loginError.style.display = 'block';
    }
});

// --- Create Operation ---

createOpBtn.addEventListener('click', () => {
    const opId = newOpIdInput.value.trim();
    const password = newOpPassInput.value.trim();

    if (!opId || !password) {
        createMsg.innerText = "All fields required.";
        createMsg.style.color = "#ff5e57";
        return;
    }

    socket.emit('create-tenant', {
        key: masterKeyInput.value.trim(), // Send key for verification
        opId,
        password
    });
});

socket.on('tenant-created', ({ success, msg, opId }) => {
    if (success) {
        createMsg.innerText = `Operation '${opId}' Created Successfully!`;
        createMsg.style.color = "#50E3C2";
        newOpIdInput.value = '';
        newOpPassInput.value = '';
        fetchOperations();
    } else {
        createMsg.innerText = msg;
        createMsg.style.color = "#ff5e57";
    }
});

// --- List Operations ---

refreshBtn.addEventListener('click', fetchOperations);

function fetchOperations() {
    socket.emit('list-tenants', { key: masterKeyInput.value.trim() });
}

socket.on('tenants-list', (tenants) => {
    // tenants is array of { opId, activeUnitsDefaultCount?? }
    opList.innerHTML = '';

    if (tenants.length === 0) {
        opList.innerHTML = '<li class="op-item" style="justify-content:center; color:#666;">No Active Operations</li>';
        return;
    }

    tenants.forEach(t => {
        const li = document.createElement('li');
        li.className = 'op-item';
        li.innerHTML = `
            <div class="op-info">
                <strong>${t.opId}</strong>
                <span>Password: ${t.adminPass}</span>
            </div>
            <span class="status-active">ACTIVE</span>
        `;
        opList.appendChild(li);
    });
});
