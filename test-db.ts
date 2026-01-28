
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function testConnection() {
    const url = process.env.POSTGRES_URL;
    console.log('Testing connection to:', url?.replace(/:[^:@]+@/, ':***@'));

    if (!url) {
        console.error('POSTGRES_URL is missing');
        return;
    }

    const pool = new Pool({
        connectionString: url,
        ssl: url.includes('amazonaws.com') ? { rejectUnauthorized: false } : undefined,
    });

    try {
        const client = await pool.connect();
        console.log('Successfully connected to Postgres!');
        const res = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' LIMIT 5');
        console.log('Tables found:', res.rows.map(r => r.table_name));
        client.release();
    } catch (err: any) {
        console.error('Connection failed:', err?.message || String(err));
    } finally {
        await pool.end();
    }
}

testConnection();
