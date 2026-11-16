require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json()); 

// Setup Koneksi ke PostgreSQL
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

pool.connect()
    .then(() => console.log('✅ Terhubung ke PostgreSQL Warkop Lembong'))
    .catch(err => console.error('❌ Error koneksi DB:', err.stack));

// --- ENDPOINT API DASAR ---

// 1. Cek status API
app.get('/api', (req, res) => {
    res.json({ status: 'success', message: 'API Warkop Lembong Berjalan Baik!' });
});

// 2. Mengambil Master Menu
app.get('/api/menus', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, name ASC');
        res.json({ status: 'success', data: result.rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 3. Endpoint Sinkronisasi Nota Jualan (Bills)
app.post('/api/sync/bills', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const { bills, bill_items } = req.body;

        if (bills && bills.length > 0) {
            for (let bill of bills) {
                await client.query(`
                    INSERT INTO bills (id, customer_name, status, payment_method, created_at)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (id) DO UPDATE 
                    SET customer_name = EXCLUDED.customer_name,
                        status = EXCLUDED.status, 
                        payment_method = EXCLUDED.payment_method
                `, [bill.id, bill.customer_name, bill.status, bill.payment_method, bill.created_at]);
            }
        }

        if (bill_items && bill_items.length > 0) {
            for (let item of bill_items) {
                await client.query(`
                    INSERT INTO bill_items (id, bill_id, menu_item_id, menu_name, qty, price, notes, is_delivered, is_cancelled, is_paid)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (id) DO UPDATE 
                    SET qty = EXCLUDED.qty,
                        notes = EXCLUDED.notes,
                        is_delivered = EXCLUDED.is_delivered,
                        is_cancelled = EXCLUDED.is_cancelled,
                        is_paid = EXCLUDED.is_paid
                `, [item.id, item.bill_id, item.menu_item_id, item.menu_name, item.qty, item.price, item.notes, item.is_delivered, item.is_cancelled, item.is_paid]);
            }
        }

        await client.query('COMMIT'); 
        res.json({ status: 'success', message: 'Data nota berhasil disinkronkan!' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error('Sync Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        client.release();
    }
});

// 4. Endpoint Sinkronisasi Pengeluaran (Expenses)
app.post('/api/sync/expenses', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { notes, items } = req.body;

        // Simpan Kepala Nota Pengeluaran
        if (notes && notes.length > 0) {
            for (let note of notes) {
                await client.query(`
                    INSERT INTO expense_notes (id, type, description, amount, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id) DO UPDATE 
                    SET type = EXCLUDED.type,
                        description = EXCLUDED.description,
                        amount = EXCLUDED.amount,
                        status = EXCLUDED.status
                `, [note.id, note.type, note.description, note.amount, note.status, note.created_at]);
            }
        }

        // Simpan Rincian Item PO Belanja
        if (items && items.length > 0) {
            for (let item of items) {
                await client.query(`
                    INSERT INTO expense_items (id, note_id, menu_id, menu_name, tracking_mode, qty, price, stock_status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (id) DO UPDATE 
                    SET qty = EXCLUDED.qty,
                        price = EXCLUDED.price,
                        stock_status = EXCLUDED.stock_status
                `, [item.id, item.note_id, item.menu_id, item.menu_name, item.tracking_mode, item.qty, item.price, item.stock_status]);
            }
        }

        await client.query('COMMIT');
        res.json({ status: 'success', message: 'Data pengeluaran berhasil disinkronkan!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Sync Expense Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        client.release();
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});