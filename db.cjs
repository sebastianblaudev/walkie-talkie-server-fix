const { createClient } = require('@supabase/supabase-js');
const mockSupabase = require('./mock_db.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vzzjkoviyodurlzsiiup.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6emprb3ZpeW9kdXJsenNpaXVwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk5Mjc2MCwiZXhwIjoyMDg2NTY4NzYwfQ.7d5zzDtJ-JKILPnF44NVpBFKUptlXRyknThyhKoTrtY';

let client;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    console.log("[DB] Initializing Supabase Client...");
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
    console.log("[DB] Using Local Mock Database...");
    client = mockSupabase;
}

module.exports = client;
