const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vzzjkoviyodurlzsiiup.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6emprb3ZpeW9kdXJsenNpaXVwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk5Mjc2MCwiZXhwIjoyMDg2NTY4NzYwfQ.7d5zzDtJ-JKILPnF44NVpBFKUptlXRyknThyhKoTrtY';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = supabase;
