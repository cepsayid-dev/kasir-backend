require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json()); 
app.use((req, res, next) => {
    console.log(`📥 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

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
// PUSH: Sinkronisasi Master Menu dari Kasir ke PostgreSQL
app.post('/api/sync/menus', async (req, res) => {
    const { menus } = req.body;
    if (!menus || !Array.isArray(menus)) {
        return res.status(400).json({ status: 'error', message: 'Data menus tidak valid' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const m of menus) {
            await client.query(
                `INSERT INTO menu_items (id, name, price, tracking_mode, stock_qty, stock_status, category)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET
                   name = EXCLUDED.name,
                   price = EXCLUDED.price,
                   tracking_mode = EXCLUDED.tracking_mode,
                   stock_qty = EXCLUDED.stock_qty,
                   stock_status = EXCLUDED.stock_status,
                   category = EXCLUDED.category`,
                [m.id, m.name, m.price, m.tracking_mode, m.stock_qty, m.stock_status, m.category]
            );
        }
        await client.query('COMMIT');
        res.json({ status: 'success', count: menus.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Sync Menus Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        client.release();
    }
});

// 3. Mengambil Daftar Pegawai Aktif (Untuk Validasi PIN Shift di Kasir)
app.get('/api/employees', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, pin, role FROM employees WHERE is_active = TRUE ORDER BY name ASC'
        );
        res.json({ status: 'success', data: result.rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 4. Endpoint Sinkronisasi Nota Jualan (Bills + Shift ID)
app.post('/api/sync/bills', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const { bills, bill_items } = req.body;

        if (bills && bills.length > 0) {
            for (let bill of bills) {
                await client.query(`
                    INSERT INTO bills (id, customer_name, status, payment_method, created_at, shift_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id) DO UPDATE 
                    SET customer_name = EXCLUDED.customer_name,
                        status = EXCLUDED.status, 
                        payment_method = EXCLUDED.payment_method,
                        shift_id = COALESCE(EXCLUDED.shift_id, bills.shift_id)
                `, [bill.id, bill.customer_name, bill.status, bill.payment_method, bill.created_at, bill.shift_id || null]);
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
        console.error('Sync Bills Error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        client.release();
    }
});

// 5. Endpoint Sinkronisasi Pengeluaran (Expenses + Shift ID)
app.post('/api/sync/expenses', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { notes, items } = req.body;

        if (notes && notes.length > 0) {
            for (let note of notes) {
                await client.query(`
                    INSERT INTO expense_notes (id, type, description, amount, status, created_at, shift_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (id) DO UPDATE 
                    SET type = EXCLUDED.type,
                        description = EXCLUDED.description,
                        amount = EXCLUDED.amount,
                        status = EXCLUDED.status,
                        shift_id = COALESCE(EXCLUDED.shift_id, expense_notes.shift_id)
                `, [note.id, note.type, note.description, note.amount, note.status, note.created_at, note.shift_id || null]);
            }
        }

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

// 6. Endpoint Sinkronisasi Shift Kasir (Buka & Tutup Shift / Blind Closing)
app.post('/api/sync/shifts', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { shifts } = req.body;

        if (shifts && shifts.length > 0) {
            for (let s of shifts) {
                await client.query(`
                    INSERT INTO cashier_shifts (
                        id, employee_id, employee_name, cashier_slot, 
                        opened_at, closed_at, opening_cash, expected_cash, 
                        actual_cash, discrepancy, status
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (id) DO UPDATE 
                    SET closed_at = EXCLUDED.closed_at,
                        expected_cash = EXCLUDED.expected_cash,
                        actual_cash = EXCLUDED.actual_cash,
                        discrepancy = EXCLUDED.discrepancy,
                        status = EXCLUDED.status
                `, [
                    s.id, s.employee_id, s.employee_name, s.cashier_slot,
                    s.opened_at, s.closed_at || null, s.opening_cash, s.expected_cash,
                    s.actual_cash, s.discrepancy, s.status
                ]);
            }
        }

        await client.query('COMMIT');
        res.json({ status: 'success', message: 'Data shift berhasil disinkronkan!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Sync Shifts Error:', error);
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