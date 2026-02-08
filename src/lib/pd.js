const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const PD_DB_PATH = process.env.PD_DB_PATH || path.join(__dirname, '../../../personal-dashboard/data/messages.db');

const db = new sqlite3.Database(PD_DB_PATH);

module.exports = { db };
