require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ========== MySQL Connection Pool (Aiven) ==========
// ========== MySQL Connection Pool (Aiven with SSL) ==========
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT),
    ssl: {
        // For Aiven "REQUIRED" mode, rejectUnauthorized: false works.
        // For production, download the CA certificate and use it.
        rejectUnauthorized: false
    },
    connectTimeout: 10000,
    waitForConnections: true,
    connectionLimit: 10
});

// Create users table if it doesn't exist
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL connected successfully');
        connection.release();

        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS users (
                userId VARCHAR(36) PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                balance DECIMAL(10,2) NOT NULL DEFAULT 100.00,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        await pool.execute(createTableSQL);
        console.log('✅ Users table ready');
    } catch (err) {
        console.error('❌ Database init error:', err.message);
        console.error('Full error:', err);
        process.exit(1);
    }
}
initDatabase();

// ========== Middleware ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'bingo_super_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper to get logged-in user from session (returns row from DB)
async function getLoggedInUser(req) {
    if (!req.session.userId) return null;
    const [rows] = await pool.execute(
        'SELECT userId, username, balance FROM users WHERE userId = ?',
        [req.session.userId]
    );
    return rows[0] || null;
}

// ========== Auth & Balance Endpoints ==========
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    try {
        // Check if username already exists
        const [existing] = await pool.execute(
            'SELECT username FROM users WHERE username = ?',
            [username]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const userId = uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.execute(
            'INSERT INTO users (userId, username, password, balance) VALUES (?, ?, ?, ?)',
            [userId, username, hashedPassword, 100]
        );
        req.session.userId = userId;
        req.session.username = username;
        res.json({ success: true, username, balance: 100 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute(
            'SELECT userId, username, password, balance FROM users WHERE username = ?',
            [username]
        );
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        req.session.userId = user.userId;
        req.session.username = user.username;
        res.json({ success: true, username: user.username, balance: user.balance });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
    const user = await getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json({ username: user.username, balance: user.balance });
});

app.post('/api/deposit', async (req, res) => {
    const user = await getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    // Simulate deposit – replace with Telebirr/Chapa integration
    const newBalance = user.balance + numAmount;
    await pool.execute(
        'UPDATE users SET balance = ? WHERE userId = ?',
        [newBalance, user.userId]
    );
    res.json({ success: true, newBalance });
});

app.post('/api/withdraw', async (req, res) => {
    const user = await getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    if (user.balance < numAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    const newBalance = user.balance - numAmount;
    await pool.execute(
        'UPDATE users SET balance = ? WHERE userId = ?',
        [newBalance, user.userId]
    );
    res.json({ success: true, newBalance });
});

// ========== Game State (in-memory) ==========
let players = {};           // socketId -> player object
let takenCards = new Set();
let gameActive = false;
let calledNumbers = [];
let autoInterval = null;
let countdownTimeout = null;
let countdownSeconds = 30;
let isLobbyOpen = true;
const GAME_COST = 10;
const HOUSE_PERCENT = 0.2;

function calculatePrize() {
    const playerCount = Object.keys(players).length;
    return GAME_COST * playerCount * (1 - HOUSE_PERCENT);
}

function generateCardFromNumber(cardNum) {
    function seededRandom(seed) {
        let x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }
    function column(min, max, seedOffset) {
        let col = [];
        let seed = cardNum * 131 + seedOffset;
        while (col.length < 5) {
            let n = Math.floor(seededRandom(seed++) * (max - min + 1)) + min;
            if (!col.includes(n)) col.push(n);
        }
        return col;
    }
    let B = column(1, 15, 1);
    let I = column(16, 30, 2);
    let N = column(31, 45, 3);
    let G = column(46, 60, 4);
    let O = column(61, 75, 5);
    let card = [];
    for (let i = 0; i < 5; i++) card.push(B[i], I[i], N[i], G[i], O[i]);
    card[12] = "FREE";
    return card;
}

function broadcastAvailableCards() {
    const available = [];
    for (let i = 1; i <= 100; i++) if (!takenCards.has(i)) available.push(i);
    io.emit('availableCards', available);
}

function broadcastPlayers() {
    const playerList = Object.values(players).map(p => ({ id: p.id, name: p.name, cardNumber: p.cardNumber }));
    io.emit('playersList', playerList);
}

function fullReset() {
    if (autoInterval) clearInterval(autoInterval);
    if (countdownTimeout) clearTimeout(countdownTimeout);
    autoInterval = null;
    gameActive = false;
    calledNumbers = [];
    isLobbyOpen = true;
    countdownSeconds = 30;
    takenCards.clear();
    players = {};
    broadcastAvailableCards();
    io.emit('lobbyReset', { countdown: countdownSeconds });
}

function startCountdown() {
    if (countdownTimeout) clearInterval(countdownTimeout);
    countdownSeconds = 30;
    io.emit('countdownTick', countdownSeconds);
    countdownTimeout = setInterval(() => {
        countdownSeconds--;
        io.emit('countdownTick', countdownSeconds);
        if (countdownSeconds <= 0) {
            clearInterval(countdownTimeout);
            countdownTimeout = null;
            startGame();
        }
    }, 1000);
}

async function startGame() {
    if (gameActive) return;

    // Deduct GAME_COST from each player's balance in DB
    const playersToRemove = [];
    for (let id in players) {
        const p = players[id];
        try {
            const [rows] = await pool.execute(
                'SELECT balance FROM users WHERE username = ?',
                [p.username]
            );
            if (rows.length === 0 || rows[0].balance < GAME_COST) {
                playersToRemove.push(id);
                io.to(id).emit('error', `Insufficient balance (need ${GAME_COST} credits). Please deposit.`);
            } else {
                const newBalance = rows[0].balance - GAME_COST;
                await pool.execute(
                    'UPDATE users SET balance = ? WHERE username = ?',
                    [newBalance, p.username]
                );
                io.to(id).emit('balanceUpdate', newBalance);
            }
        } catch (err) {
            console.error(err);
            playersToRemove.push(id);
            io.to(id).emit('error', 'Database error, cannot start game');
        }
    }

    playersToRemove.forEach(id => {
        const cardNum = players[id].cardNumber;
        takenCards.delete(cardNum);
        delete players[id];
    });
    broadcastAvailableCards();
    broadcastPlayers();

    if (Object.keys(players).length === 0) {
        io.emit('gameError', 'No players with enough balance. Game canceled.');
        fullReset();
        return;
    }

    gameActive = true;
    isLobbyOpen = false;
    calledNumbers = [];
    io.emit('gameStarted');

    for (let id in players) {
        const p = players[id];
        p.marked = new Array(25).fill(false);
        p.marked[12] = true;
        io.to(id).emit('cardAssigned', {
            playerId: id,
            card: p.card,
            gameActive: true
        });
    }

    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => {
        if (!gameActive) return;
        let available = [];
        for (let i = 1; i <= 75; i++) if (!calledNumbers.includes(i)) available.push(i);
        if (available.length === 0) {
            fullReset();
            return;
        }
        const newNumber = available[Math.floor(Math.random() * available.length)];
        calledNumbers.push(newNumber);
        io.emit('newNumber', newNumber);
    }, 4000);
}

function checkWin(marked) {
    // Rows
    for (let r = 0; r < 5; r++) {
        let win = true;
        for (let c = 0; c < 5; c++) if (!marked[r * 5 + c]) { win = false; break; }
        if (win) return true;
    }
    // Columns
    for (let c = 0; c < 5; c++) {
        let win = true;
        for (let r = 0; r < 5; r++) if (!marked[r * 5 + c]) { win = false; break; }
        if (win) return true;
    }
    // Diagonals
    let diag1 = true, diag2 = true;
    for (let i = 0; i < 5; i++) {
        if (!marked[i * 5 + i]) diag1 = false;
        if (!marked[i * 5 + (4 - i)]) diag2 = false;
    }
    if (diag1 || diag2) return true;
    // Four corners
    const corners = [0, 4, 20, 24];
    return corners.every(idx => marked[idx]);
}

async function handleMark(socketId, cellIndex, numberValue) {
    const player = players[socketId];
    if (!player || !gameActive) return false;
    if (!calledNumbers.includes(numberValue)) return false;
    if (player.card[cellIndex] !== numberValue) return false;
    if (player.marked[cellIndex]) return false;

    player.marked[cellIndex] = true;
    io.to(socketId).emit('markConfirmed', { cellIndex, number: numberValue });

    if (checkWin(player.marked)) {
        gameActive = false;
        if (autoInterval) clearInterval(autoInterval);
        autoInterval = null;

        const prize = calculatePrize();

        // Award prize to winner from DB
        try {
            const [rows] = await pool.execute(
                'SELECT balance FROM users WHERE username = ?',
                [player.username]
            );
            if (rows.length > 0) {
                const newBalance = rows[0].balance + prize;
                await pool.execute(
                    'UPDATE users SET balance = ? WHERE username = ?',
                    [newBalance, player.username]
                );
                io.to(socketId).emit('balanceUpdate', newBalance);
            }
        } catch (err) {
            console.error('Failed to award prize:', err);
        }

        io.emit('gameWinner', {
            winnerId: socketId,
            winnerName: player.name,
            prize: prize,
            players: Object.keys(players).length
        });
        io.emit('prizeUpdate', {
            prize: prize,
            players: Object.keys(players).length
        });

        setTimeout(() => fullReset(), 5000);
        return true;
    }
    return false;
}

// ========== Socket.IO ==========
io.on('connection', (socket) => {
    console.log('Client connected', socket.id);

    socket.on('auth', async ({ userId, username }) => {
        socket.userId = userId;
        socket.username = username;
        const available = [];
        for (let i = 1; i <= 100; i++) if (!takenCards.has(i)) available.push(i);
        socket.emit('availableCards', available);
        socket.emit('lobbyState', { isLobbyOpen, countdown: countdownSeconds, gameActive });

        // Send current balance
        try {
            const [rows] = await pool.execute('SELECT balance FROM users WHERE username = ?', [username]);
            if (rows.length) socket.emit('balanceUpdate', rows[0].balance);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('selectCard', ({ name, cardNumber }) => {
        if (!isLobbyOpen) {
            socket.emit('joinError', 'Game already started');
            return;
        }
        const num = parseInt(cardNumber);
        if (isNaN(num) || num < 1 || num > 100) return;
        if (takenCards.has(num)) {
            socket.emit('joinError', `Card ${num} already taken`);
            return;
        }
        if (players[socket.id]) {
            takenCards.delete(players[socket.id].cardNumber);
        }
        takenCards.add(num);
        const card = generateCardFromNumber(num);
        players[socket.id] = {
            id: socket.id,
            name: name,
            cardNumber: num,
            card: card,
            marked: new Array(25).fill(false),
            userId: socket.userId,
            username: socket.username
        };
        players[socket.id].marked[12] = true;
        socket.emit('cardAssigned', { playerId: socket.id, card, gameActive: false });
        broadcastAvailableCards();
        broadcastPlayers();
        if (Object.keys(players).length === 1 && isLobbyOpen && !countdownTimeout) {
            startCountdown();
        }
    });

    socket.on('markNumber', ({ cellIndex, number }) => {
        handleMark(socket.id, cellIndex, number);
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const cardNum = players[socket.id].cardNumber;
            takenCards.delete(cardNum);
            delete players[socket.id];
            broadcastAvailableCards();
            broadcastPlayers();
        }
        if (Object.keys(players).length === 0 && autoInterval) {
            clearInterval(autoInterval);
            autoInterval = null;
            gameActive = false;
            isLobbyOpen = true;
            if (countdownTimeout) clearTimeout(countdownTimeout);
            countdownTimeout = null;
            countdownSeconds = 30;
        }
    });
});

const PORT = process.env.PORT || 13926;
server.listen(PORT, () => console.log(`✅ Bingo server running on http://localhost:${PORT}`));