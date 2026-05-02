const express = require('express');
const { Pool } = require('pg');
const http = require('http'); // <-- REQUERIDO PARA WEBSOCKETS
const { Server } = require('socket.io'); // <-- REQUERIDO PARA WEBSOCKETS

const app = express();
const server = http.createServer(app); // <-- ENVOLVEMOS EXPRESS

// CONFIGURACIÓN DE SEGURIDAD (CORS) PARA RENDER
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Configuración de la conexión a AWS RDS
const pool = new Pool({
    user: 'postgres',
    host: 'database-1.ct6ssasymo8y.mx-central-1.rds.amazonaws.com',
    database: 'bioaccess',
    password: 'AdminBio123',
    port: 5432,
    ssl: {
        rejectUnauthorized: false
    }
});

app.use(express.static('public'));
app.use(express.json());

// Testigo de conexión en consola del servidor
io.on('connection', (socket) => {
    console.log('🟢 [WebSocket] Un navegador se ha conectado al Dashboard');
});

// --- VARIABLES GLOBALES PARA EL MODO ENROLAMIENTO ---
let modo_sensor = "LEER"; // Puede ser "LEER" o "ENROLAR"
let id_a_enrolar = null;

// --- 1. RUTA: REGISTRAR ACCESOS (AHORA ES DINÁMICA) ---
app.post('/api/registrar-acceso', async (req, res) => {
    const { huella_id, estado } = req.body; // El ESP32 ya no manda el nombre
    try {
        let nombre_real = "Desconocido";

        // Si el estado es Concedido, buscamos quién es el dueño de ese ID en AWS
        if (estado === "Concedido") {
            const user = await pool.query('SELECT nombre FROM usuarios WHERE huella_id = $1', [huella_id]);
            if (user.rows.length > 0) {
                nombre_real = user.rows[0].nombre;
            } else {
                nombre_real = "Usuario sin registrar";
            }
        }

        // Guardamos el historial con el nombre real de la base de datos
        await pool.query(
            'INSERT INTO registros_acceso (huella_id, nombre, estado) VALUES ($1, $2, $3)',
            [huella_id, nombre_real, estado]
        );
        console.log(`✅ Acceso ${estado}: ${nombre_real} (ID Sensor: ${huella_id})`);
        
        // Disparamos el WebSocket a la página web
        io.emit('nuevo_acceso', { huella_id, nombre: nombre_real, estado, fecha_hora: new Date() });
        res.status(200).json({ mensaje: "Acceso registrado" });
    } catch (err) {
        console.error("❌ Error DB:", err.message);
        res.status(500).json({ error: "Error en la base de datos" });
    }
});

// --- 2. RUTAS PARA EL ENROLAMIENTO (COMUNICACIÓN WEB <-> ESP32) ---

// La página web llama a esta ruta cuando presionas "Guardar y Enrolar"
app.post('/api/iniciar-enrolamiento', (req, res) => {
    const { id_sensor } = req.body;
    modo_sensor = "ENROLAR";
    id_a_enrolar = id_sensor;
    console.log(`⚠️ MODO ENROLAMIENTO ACTIVADO para el ID: ${id_sensor}`);
    res.status(200).json({ mensaje: "Esperando huella en el sensor..." });
});

// El ESP32 estará preguntando a esta ruta cada 2 segundos "¿Qué hago?"
app.get('/api/estado-sensor', (req, res) => {
    res.json({ modo: modo_sensor, id: id_a_enrolar });
});

// El ESP32 avisa a esta ruta cuando terminó de escanear la huella nueva
app.post('/api/exito-enrolamiento', (req, res) => {
    console.log("✅ ESP32 confirma que la huella fue grabada físicamente.");
    modo_sensor = "LEER"; // Regresamos el sistema a la normalidad
    id_a_enrolar = null;
    io.emit('enrolamiento_completado'); // Le avisa a la animación de tu web que ya acabó
    res.status(200).json({ mensaje: "Modo lectura restaurado" });
});

// 2. RUTA PARA LISTAR USUARIOS
app.get('/api/lista-usuarios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM usuarios ORDER BY id_usuario DESC LIMIT 10');
        res.json(resultado.rows);
    } catch (err) {
        res.status(500).json({ error: "Error al obtener usuarios" });
    }
});

// 3. RUTA PARA EL HISTORIAL INICIAL
app.get('/api/historial', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM registros_acceso ORDER BY fecha_hora DESC LIMIT 10');
        res.json(resultado.rows); 
    } catch (err) {
        console.error("❌ Error DB:", err.message);
        res.status(500).json({ error: "Error al consultar la base de datos" });
    }
});

// 4. RUTA PARA ELIMINAR USUARIOS
app.delete('/api/eliminar-usuario/:id', async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM registros_acceso WHERE huella_id = $1', [id]);
        const resultado = await pool.query('DELETE FROM usuarios WHERE huella_id = $1', [id]);

        if (resultado.rowCount > 0) {
            console.log(`🗑️ Usuario con ID ${id} eliminado correctamente.`);
            res.status(200).json({ mensaje: 'Usuario eliminado' });
        } else {
            res.status(404).json({ error: "Usuario no encontrado" });
        }
    } catch (err) {
        console.error("❌ Error al eliminar:", err.message);
        res.status(500).json({ error: "Error interno al eliminar" });
    }
});

// 5. RUTA PARA LOGIN 
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const id_numero = parseInt(usuario, 10);
        const resultado = await pool.query(
            'SELECT * FROM administradores WHERE id_empleado = $1 AND password = $2', 
            [id_numero, password]
        );

        if (resultado.rows.length > 0) {
            res.status(200).json({ success: true, token: 'bioaccess-auth-token-xyz' });
        } else {
            res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
        }
    } catch (err) {
        console.error("❌ Error en el inicio de sesión:", err.message);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// 6. RUTA PARA EL HISTORIAL COMPLETO
app.get('/api/historial-completo', async (req, res) => {
    try {
        const query = `
            SELECT 
                r.id_registro, 
                r.huella_id, 
                r.nombre, 
                COALESCE(u.departamento, 'N/A') AS departamento, 
                r.fecha_hora, 
                r.estado
            FROM registros_acceso r
            LEFT JOIN usuarios u ON r.huella_id = u.huella_id
            ORDER BY r.fecha_hora DESC
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows); 
    } catch (err) {
        console.error("Error al obtener historial:", err);
        res.status(500).json({ error: "Error al consultar la base de datos" });
    }
});

// 7. RUTA PARA REGISTRAR ACCESOS DESDE EL ESP32 (¡AQUÍ SUCEDE LA MAGIA EN TIEMPO REAL!)
app.post('/api/registrar-acceso', async (req, res) => {
    const { huella_id, nombre, estado } = req.body;
    try {
        // Guardamos en AWS
        await pool.query(
            'INSERT INTO registros_acceso (huella_id, nombre, estado) VALUES ($1, $2, $3)',
            [huella_id, nombre, estado]
        );
        console.log(`✅ Acceso registrado desde el ESP32 para: ${nombre}`);
        
        // EMITIMOS EL EVENTO WEBSOCKET A TODOS LOS NAVEGADORES
        io.emit('nuevo_acceso', { 
            huella_id, 
            nombre, 
            estado, 
            fecha_hora: new Date() 
        });
        
        // Confirmamos al ESP32
        res.status(200).json({ mensaje: "Acceso registrado correctamente" });
    } catch (err) {
        console.error("❌ Error al guardar el acceso:", err.message);
        res.status(500).json({ error: "Error interno en la base de datos" });
    }
});

// 8. RUTA: CONTADOR REAL DE ACCESOS DE HOY
app.get('/api/accesos-hoy', async (req, res) => {
    try {
        const query = `
            SELECT COUNT(*) 
            FROM registros_acceso 
            WHERE DATE(fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Tijuana') = DATE(CURRENT_TIMESTAMP AT TIME ZONE 'America/Tijuana')
        `;
        const resultado = await pool.query(query);
        res.json({ total: parseInt(resultado.rows[0].count, 10) });
    } catch (err) {
        console.error("❌ Error al contar accesos de hoy:", err);
        res.status(500).json({ error: "Error en la base de datos" });
    }
});

// --- INICIO DEL SERVIDOR ---
pool.connect()
    .then(() => {
        console.log('✅ Conexión exitosa a AWS RDS');
        // AHORA USAMOS server.listen EN LUGAR DE app.listen
        server.listen(PORT, () => {
            console.log(`🌐 Servidor BioAccess y WebSockets activos en puerto ${PORT}`);
        });
    })
    .catch(err => console.error('❌ Error fatal al conectar a la DB:', err.message));
