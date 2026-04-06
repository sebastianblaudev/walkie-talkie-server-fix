const fs = require('fs');
const path = require('path');

const MOCK_DB_PATH = path.join(__dirname, 'mock_db.json');

// Initial state
const initialState = {
    operations: [],
    channels: [],
    operation_tokens: [],
    units: []
};

function readDB() {
    if (!fs.existsSync(MOCK_DB_PATH)) {
        fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(initialState, null, 2));
    }
    return JSON.parse(fs.readFileSync(MOCK_DB_PATH, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(data, null, 2));
}

const mockSupabase = {
    from: (table) => {
        let filters = [];
        return {
            select: function(query) {
                return {
                    eq: (col, val) => {
                        filters.push({ type: 'eq', col, val });
                        return this.select(query); // Return the same object for chaining
                    },
                    neq: (col, val) => {
                        filters.push({ type: 'neq', col, val });
                        return this.select(query);
                    },
                    single: async () => {
                        const db = readDB();
                        let data = db[table] || [];
                        filters.forEach(f => {
                            if (f.type === 'eq') data = data.filter(i => i[f.col] === f.val);
                            if (f.type === 'neq') data = data.filter(i => i[f.col] !== f.val);
                        });
                        filters = []; // Reset for next call
                        const item = data[0];
                        return { data: item, error: item ? null : { message: 'Not found' } };
                    },
                    then: async (resolve) => { // Handle awaiting the select object directly
                        const db = readDB();
                        let data = db[table] || [];
                        filters.forEach(f => {
                            if (f.type === 'eq') data = data.filter(i => i[f.col] === f.val);
                            if (f.type === 'neq') data = data.filter(i => i[f.col] !== f.val);
                        });
                        filters = [];
                        resolve({ data, error: null });
                    }
                };
            },
            insert: async (data) => {
                const db = readDB();
                if (!db[table]) db[table] = [];
                if (Array.isArray(data)) {
                    db[table].push(...data);
                } else {
                    db[table].push(data);
                }
                writeDB(db);
                return { error: null };
            },
            upsert: async (data) => {
                const db = readDB();
                if (!db[table]) db[table] = [];
                const index = db[table].findIndex(i => i.id === data.id);
                if (index !== -1) {
                    db[table][index] = { ...db[table][index], ...data };
                } else {
                    db[table].push(data);
                }
                writeDB(db);
                return { error: null };
            },
            update: (updateData) => ({
                eq: async (col, val) => {
                    const db = readDB();
                    if (!db[table]) return { error: { message: 'Not found' } };
                    let found = false;
                    db[table].forEach((item, index) => {
                        if (item[col] === val) {
                            db[table][index] = { ...item, ...updateData };
                            found = true;
                        }
                    });
                    if (found) {
                        writeDB(db);
                        return { error: null };
                    }
                    return { error: { message: 'Not found' } };
                }
            }),
            delete: () => ({
                match: async (filter) => {
                    const db = readDB();
                    if (!db[table]) return { error: null };
                    db[table] = db[table].filter(i => {
                        return !Object.entries(filter).every(([k, v]) => i[k] === v);
                    });
                    writeDB(db);
                    return { error: null };
                }
            })
        };
    }
};

module.exports = mockSupabase;
