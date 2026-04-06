const { createClient } = require('@supabase/supabase-js');
const mockSupabase = require('./mock_db.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let client;

// Check if we have valid-looking Supabase credentials that aren't the broken default
const isBrokenURL = SUPABASE_URL === 'https://vzzjkoviyodurlzsiiup.supabase.co';

if (SUPABASE_URL && SUPABASE_SERVICE_KEY && !isBrokenURL) {
    console.log("[DB] Initializing Supabase Client...");
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
    console.log("[DB] Using Local Mock Database...");
    client = mockSupabase;
}

module.exports = client;
