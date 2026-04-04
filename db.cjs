require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const mockSupabase = require('./mock_db.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let client;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    console.log("-----------------------------------------");
    console.log("[DB] SUCCESS: Initializing Supabase...");
    console.log(`[DB] Target URL: ${SUPABASE_URL}`);
    console.log("-----------------------------------------");
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
    console.log("-----------------------------------------");
    console.log("[DB] WARNING: Missing Supabase Credentials.");
    console.log("[DB] Using Local Mock Database (mock_db.json)");
    console.log("[DB] To fix: Add SUPABASE_URL and SUPABASE_SERVICE_KEY to .env");
    console.log("-----------------------------------------");
    client = mockSupabase;
}

module.exports = client;

