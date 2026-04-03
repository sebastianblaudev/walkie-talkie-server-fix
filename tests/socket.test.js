import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as Client } from 'socket.io-client';
import { server } from '../server.cjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_DB_PATH = path.join(__dirname, '../mock_db.json');

describe('Socket Server Integration (server.cjs)', () => {
    let clientSocket;
    const port = 3001;

    beforeAll(() => {
        return new Promise((resolve) => {
            server.listen(port, () => {
                resolve();
            });
        });
    });

    afterAll(() => {
        server.close();
    });

    it('should connect and authenticate a super admin', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            clientSocket.on('connect', () => {
                clientSocket.emit('login-super-admin', { key: 'Cclass2022***' });
                clientSocket.on('super-admin-auth', (data) => {
                    expect(data.success).toBe(true);
                    clientSocket.disconnect();
                    resolve();
                });
            });
        });
    });

    it('should create a tenant and list it', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            clientSocket.on('connect', () => {
                clientSocket.emit('create-tenant', { 
                    key: 'Cclass2022***', 
                    opId: 'test-op-1', 
                    password: 'pass' 
                });
                clientSocket.on('tenant-created', (data) => {
                    expect(data.success).toBe(true);
                    expect(data.opId).toBe('test-op-1');

                    clientSocket.emit('list-tenants', { key: 'Cclass2022***' });
                    clientSocket.on('tenants-list', (list) => {
                        expect(list.some(t => t.opId === 'test-op-1')).toBe(true);
                        clientSocket.disconnect();
                        resolve();
                    });
                });
            });
        });
    });

    it('should receive existing users when joining a channel', () => {
        const client1 = new Client(`http://localhost:${port}`, { autoConnect: false });
        const client2 = new Client(`http://localhost:${port}`, { autoConnect: false });
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Test timed out manually")), 8000);

            client1.on('connect', () => {
                console.log("Client 1 connected");
                client1.emit('join-operation', { opId: 'test-op-1', token: 't1', userId: 'u1', callSign: 'C1' });
                client1.on('operation-config', () => {
                    console.log("Client 1 config received");
                    client1.emit('join-channel', { opId: 'test-op-1', channelName: 'CHANNEL 1' });
                    
                    // Once client1 is in, join client2 after a short delay
                    setTimeout(() => {
                        client2.on('connect', () => {
                            console.log("Client 2 connected");
                            client2.emit('join-operation', { opId: 'test-op-1', token: 't1', userId: 'u2', callSign: 'C2' });
                            client2.on('operation-config', () => {
                                console.log("Client 2 config received");
                                client2.emit('join-channel', { opId: 'test-op-1', channelName: 'CHANNEL 1' });
                                client2.on('room-users', (users) => {
                                    console.log("Client 2 room-users received:", users);
                                    expect(users).toContain(client1.id);
                                    client1.disconnect();
                                    client2.disconnect();
                                    clearTimeout(timeout);
                                    resolve();
                                });
                            });
                        });
                        client2.connect();
                    }, 500);
                });
            });
            client1.connect();
        }, 12000);
    });

    it('should handle operator joining an operation and channel', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            clientSocket.on('connect', () => {
                clientSocket.emit('join-operation', {
                    opId: 'test-op-1',
                    token: 'some-token',
                    userId: 'u1',
                    callSign: 'SIG-1'
                });

                clientSocket.on('operation-config', (config) => {
                    expect(config.opId).toBe('test-op-1');
                    expect(config.channels).toContain('CHANNEL 1');

                    clientSocket.emit('join-channel', { opId: 'test-op-1', channelName: 'CHANNEL 1' });
                    // No direct event for success, but we can check if we receive room size
                    clientSocket.on('channel-users-count', (count) => {
                        expect(count).toBeGreaterThan(0);
                        clientSocket.disconnect();
                        resolve();
                    });
                });
            });
        });
    });
});
