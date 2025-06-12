const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Adjust according to your frontend domain
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.static('public')); // Serve static files
app.use(express.json()); // Parse JSON bodies for API endpoints

// PostgreSQL connection
// const pool = new Pool({
//   user: 'postgres',
//   host: 'localhost',
//   database: 'test5',
//   password: '1234',
//   port: 5432,
// });
const pool = new Pool({
  user: 'grupo22sc',
  host: 'mail.tecnoweb.org.bo',
  database: 'db_grupo22sc',
  password: 'grup022grup022*',
  port: 5432,
});
// PostgreSQL connection using environment variables
// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL, // Use Render's DB URL from .env
//   ssl: {
//     rejectUnauthorized: false // Required for Render's SSL
//   }
// });

// pool.connect((err) => {
//   if (err) {
//     console.error('Database connection error:', err.stack);
//   } else {
//     console.log('Connected to PostgreSQL database');
//   }
// });

// Create tables if they don't exist
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS screens (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        device JSONB NOT NULL,
        components JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

initializeDatabase();

// Middleware to verify room access
io.use(async (socket, next) => {
  const { roomName, password } = socket.handshake.auth;
  if (!roomName) {
    return next(new Error('Room name is required'));
  }
  try {
    const result = await pool.query('SELECT password_hash FROM rooms WHERE name = $1', [roomName]);
    if (result.rows.length === 0) {
      return next(new Error('Room not found'));
    }
    const { password_hash } = result.rows[0];
    if (password_hash && !password) {
      return next(new Error('Password required'));
    }
    if (password_hash && !(await bcrypt.compare(password, password_hash))) {
      return next(new Error('Invalid password'));
    }
    socket.roomName = roomName; // Store roomName for use in connection handling
    next();
  } catch (err) {
    console.error('Error in socket middleware:', err);
    next(new Error('Authentication error'));
  }
});

// API to list all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM rooms ORDER BY created_at DESC');
    const rooms = result.rows.map(row => ({
      id: row.id,
      name: row.name
    }));
    res.json(rooms);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// API to create a room
app.post('/api/rooms', async (req, res) => {
  const { name, password } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Room name is required' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }
    const result = await pool.query(
      'INSERT INTO rooms (name, password_hash) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id, name',
      [name, passwordHash]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Room name already exists' });
    }
    const { id: roomId, name: roomName } = result.rows[0];

    // Create a default screen for the room
    const defaultScreen = {
      name: 'Pantalla 1',
      device: { name: 'iPhone 14', width: 375, height: 667 },
      components: [],
    };
    await pool.query(
      'INSERT INTO screens (room_id, name, device, components) VALUES ($1, $2, $3, $4)',
      [roomId, defaultScreen.name, defaultScreen.device, defaultScreen.components]
    );

    res.json({ roomName });
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// API to join a room
app.post('/api/rooms/join', async (req, res) => {
  const { roomName, password } = req.body;
  if (!roomName) {
    return res.status(400).json({ error: 'Room name is required' });
  }
  try {
    const result = await pool.query('SELECT password_hash FROM rooms WHERE name = $1', [roomName]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const { password_hash } = result.rows[0];
    if (password_hash && !password) {
      return res.status(401).json({ error: 'Password required' });
    }
    if (password_hash && !(await bcrypt.compare(password, password_hash))) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    res.json({ success: true, roomName });
  } catch (err) {
    console.error('Error joining room:', err);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  const { roomName } = socket; // Use roomName stored in middleware
  console.log(`Usuario conectado: ${socket.id} a la sala ${roomName}`);

  // Join the room
  socket.join(roomName);

  // Send initial state
  async function sendInitialState() {
    try {
      const result = await pool.query(
        'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      const screens = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        components: row.components,
      }));
      socket.emit('init', screens);
    } catch (err) {
      console.error('Error fetching initial screens:', err);
    }
  }

  sendInitialState();

  // Handle component addition
  socket.on('addComponent', async ({ screenId, component }) => {
    try {
      const result = await pool.query(
        'UPDATE screens SET components = components || $1::jsonb WHERE id = $2 AND room_id = (SELECT id FROM rooms WHERE name = $3) RETURNING components',
        [JSON.stringify([component]), screenId, roomName]
      );
      if (result.rows.length > 0) {
        const screens = await pool.query(
          'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
          [roomName]
        );
        io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
          id: row.id,
          name: row.name,
          device: row.device,
          components: row.components,
        })));
      }
    } catch (err) {
      console.error('Error adding component:', err);
    }
  });

  // Handle component movement
  socket.on('moveComponent', async ({ screenId, componentId, xRatio, yRatio }) => {
    try {
      const result = await pool.query(
        'SELECT components FROM screens WHERE id = $1 AND room_id = (SELECT id FROM rooms WHERE name = $2)',
        [screenId, roomName]
      );
      if (result.rows.length > 0) {
        const components = result.rows[0].components.map((comp) =>
          comp.id === componentId ? { ...comp, xRatio, yRatio } : comp
        );
        await pool.query(
          'UPDATE screens SET components = $1::jsonb WHERE id = $2 AND room_id = (SELECT id FROM rooms WHERE name = $3)',
          [JSON.stringify(components), screenId, roomName]
        );
        const screens = await pool.query(
          'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
          [roomName]
        );
        io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
          id: row.id,
          name: row.name,
          device: row.device,
          components: row.components,
        })));
      }
    } catch (err) {
      console.error('Error moving component:', err);
    }
  });

  // Handle component deletion
  socket.on('deleteComponent', async ({ screenId, componentId }) => {
    try {
      const result = await pool.query(
        'SELECT components FROM screens WHERE id = $1 AND room_id = (SELECT id FROM rooms WHERE name = $2)',
        [screenId, roomName]
      );
      if (result.rows.length > 0) {
        const components = result.rows[0].components.filter((comp) => comp.id !== componentId);
        await pool.query(
          'UPDATE screens SET components = $1::jsonb WHERE id = $2 AND room_id = (SELECT id FROM rooms WHERE name = $3)',
          [JSON.stringify(components), screenId, roomName]
        );
        const screens = await pool.query(
          'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
          [roomName]
        );
        io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
          id: row.id,
          name: row.name,
          device: row.device,
          components: row.components,
        })));
      }
    } catch (err) {
      console.error('Error deleting component:', err);
    }
  });

  // Handle screen addition
  socket.on('addScreen', async (newScreen) => {
    try {
      await pool.query(
        'INSERT INTO screens (room_id, name, device, components) VALUES ((SELECT id FROM rooms WHERE name = $1), $2, $3, $4)',
        [roomName, newScreen.name, newScreen.device, newScreen.components]
      );
      const screens = await pool.query(
        'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        components: row.components,
      })));
    } catch (err) {
      console.error('Error adding screen:', err);
    }
  });

  // Handle screen deletion
  socket.on('deleteScreen', async (screenId) => {
    try {
      const result = await pool.query(
        'SELECT COUNT(*) FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      if (result.rows[0].count <= 1) return; // Prevent deleting the last screen
      await pool.query(
        'DELETE FROM screens WHERE id = $1 AND room_id = (SELECT id FROM rooms WHERE name = $2)',
        [screenId, roomName]
      );
      const screens = await pool.query(
        'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        components: row.components,
      })));
    } catch (err) {
      console.error('Error deleting screen:', err);
    }
  });

  // Handle screen renaming
  socket.on('renameScreen', async ({ screenId, newName }) => {
    try {
      await pool.query(
        'UPDATE screens SET name = $1 WHERE id = $2 AND room_id = (SELECT id FROM rooms WHERE name = $3)',
        [newName, screenId, roomName]
      );
      const screens = await pool.query(
        'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        components: row.components,
      })));
    } catch (err) {
      console.error('Error renaming screen:', err);
    }
  });

  // Handle device change
  socket.on('changeDevice', async ({ screenId, device }) => {
    try {
      await pool.query(
        'UPDATE screens SET device = $1::jsonb WHERE id = $2 AND room_id = (SELECT id FROM rooms WHERE name = $3)',
        [JSON.stringify(device), screenId, roomName]
      );
      const screens = await pool.query(
        'SELECT * FROM screens WHERE room_id = (SELECT id FROM rooms WHERE name = $1)',
        [roomName]
      );
      io.to(roomName).emit('updateScreens', screens.rows.map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        components: row.components,
      })));
    } catch (err) {
      console.error('Error changing device:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id} de la sala ${roomName}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));