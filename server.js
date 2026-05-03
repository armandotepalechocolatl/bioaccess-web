const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CONFIGURACIÓN DE SEGURIDAD (CORS) PARA RENDER
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// Configuración de la conexión a AWS RDS
const pool = new Pool({
    user: 'postgres',
    host: 'database-1.ct6ssasymo8y.mx-central-1.rds.amazonaws.com',
    database: 'bioaccess',
    password: 'AdminBio123',
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

app.use(express.static('public'));
app.use(express.json());

io.on('connection', (socket) => {
    console.log('🟢 [WebSocket] Un navegador se ha conectado al Dashboard');
});

// --- VARIABLES GLOBALES ---
let modo_sensor = "LEER";
let id_a_enrolar = null;
let ids_para_eliminar_fisicamente = []; // 🗑️ Cola de tareas de borrado para el ESP32

// --- 1. RUTA: REGISTRAR NUEVO USUARIO EN AWS ---
app.post('/api/registrar-usuario', async (req, res) => {
    const { nombre, departamento, huella_id } = req.body;
    console.log(`\n▶️ Intentando registrar usuario: ${nombre} | Depto: ${departamento} | ID: ${huella_id}`);

    try {
        const verificacion = await pool.query('SELECT nombre FROM usuarios WHERE huella_id = $1', [huella_id]);
        if (verificacion.rows.length > 0) {
            console.log(`⚠️ Rechazado: El ID ${huella_id} ya está en uso.`);
            return res.status(400).json({ error: 'El ID ya está en uso' });
        }

        await pool.query(
            'INSERT INTO usuarios (huella_id, nombre, departamento) VALUES ($1, $2, $3)',
            [huella_id, nombre, departamento]
        );
        console.log(`✅ ÉXITO: Usuario guardado en BD. Esperando huella física...`);
        res.status(200).json({ mensaje: 'Usuario guardado en base de datos' });
    } catch (err) {
        console.error("❌ ERROR CRÍTICO SQL AL REGISTRAR:", err.message);
        res.status(500).json({ error: 'Error interno de la base de datos' });
    }
});

// --- 2. RUTA: REGISTRAR ACCESOS CON FILTRO ANTI-FANTASMAS ---
app.post('/api/registrar-acceso', async (req, res) => {
    const { huella_id, estado } = req.body; 
    try {
        let nombre_real = "Desconocido";
        let estado_final = estado;

        // Doble validación: Si el sensor dice Concedido, verificamos que siga en la BD
        if (estado === "Concedido") {
            const user = await pool.query('SELECT nombre FROM usuarios WHERE huella_id = $1', [huella_id]);
            if (user.rows.length > 0) {
                nombre_real = user.rows[0].nombre;
            } else {
                nombre_real = "Usuario Dado de Baja";
                estado_final = "Denegado"; // Bloqueamos al fantasma
            }
        }

        await pool.query(
            'INSERT INTO registros_acceso (huella_id, nombre, estado) VALUES ($1, $2, $3)',
            [huella_id, nombre_real, estado_final]
        );
        console.log(`✅ Acceso ${estado_final}: ${nombre_real} (ID: ${huella_id})`);
        
        io.emit('nuevo_acceso', { huella_id, nombre: nombre_real, estado: estado_final, fecha_hora: new Date() });
        res.status(200).json({ mensaje: "Acceso registrado" });
    } catch (err) {
        console.error("❌ Error DB:", err.message);
        res.status(500).json({ error: "Error en la base de datos" });
    }
});

// --- 3. RUTAS PARA EL ENROLAMIENTO Y ESTADO ---
app.post('/api/iniciar-enrolamiento', (req, res) => {
    const { id_sensor } = req.body;
    modo_sensor = "ENROLAR";
    id_a_enrolar = id_sensor;
    console.log(`⚠️ MODO ENROLAMIENTO ACTIVADO para ID: ${id_sensor}`);
    res.status(200).json({ mensaje: "Esperando huella en el sensor..." });
});

// Aquí el ESP32 pregunta qué debe hacer. Le pasamos los borrados pendientes primero.
app.get('/api/estado-sensor', (req, res) => {
    if (ids_para_eliminar_fisicamente.length > 0) {
        const id_borrar = ids_para_eliminar_fisicamente.shift(); // Saca el ID de la cola
        console.log(`📡 Ordenando al ESP32 borrar físicamente el ID: ${id_borrar}`);
        res.json({ modo: "BORRAR_FISICO", id: id_borrar });
    } else {
        res.json({ modo: modo_sensor, id: id_a_enrolar });
    }
});

app.post('/api/progreso', (req, res) => {
    const { mensaje } = req.body;
    io.emit('actualizacion_pantalla', mensaje);
    res.status(200).send("OK");
});

app.post('/api/exito-enrolamiento', (req, res) => {
    console.log("✅ ESP32 confirma que la huella fue grabada físicamente.");
    modo_sensor = "LEER"; 
    id_a_enrolar = null;
    io.emit('enrolamiento_completado'); 
    res.status(200).json({ mensaje: "Modo lectura restaurado" });
});

// --- 4. RUTA PARA LISTAR USUARIOS ---
app.get('/api/lista-usuarios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM usuarios ORDER BY id_usuario DESC LIMIT 10');
        res.json(resultado.rows);
    } catch (err) { res.status(500).json({ error: "Error al obtener usuarios" }); }
});

// --- 5. RUTA PARA HISTORIAL INICIAL ---
app.get('/api/historial', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM registros_acceso ORDER BY fecha_hora DESC LIMIT 10');
        res.json(resultado.rows); 
    } catch (err) { res.status(500).json({ error: "Error DB" }); }
});

// --- 6. RUTA PARA ELIMINAR USUARIOS ---
app.delete('/api/eliminar-usuario/:id', async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM registros_acceso WHERE huella_id = $1', [id]);
        const resultado = await pool.query('DELETE FROM usuarios WHERE huella_id = $1', [id]);
        
        if (resultado.rowCount > 0) {
            // Mandamos el ID a la cola para que el ESP32 lo borre físicamente
            ids_para_eliminar_fisicamente.push(parseInt(id));
            console.log(`🗑️ ID ${id} eliminado de AWS y en cola para borrado del sensor.`);
            res.status(200).json({ mensaje: 'Usuario eliminado' });
        } else {
            res.status(404).json({ error: "Usuario no encontrado" });
        }
    } catch (err) { res.status(500).json({ error: "Error interno" }); }
});

// --- 7. RUTA PARA LOGIN ---
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const id_numero = parseInt(usuario, 10);
        const resultado = await pool.query(
            'SELECT * FROM administradores WHERE id_empleado = $1 AND password = $2', 
            [id_numero, password]
        );
        if (resultado.rows.length > 0) res.status(200).json({ success: true, token: 'bioaccess-auth-token-xyz' });
        else res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    } catch (err) { res.status(500).json({ success: false, message: 'Error interno' }); }
});

// --- 8. HISTORIAL COMPLETO ---
app.get('/api/historial-completo', async (req, res) => {
    try {
        const query = `SELECT r.id_registro, r.huella_id, r.nombre, COALESCE(u.departamento, 'N/A') AS departamento, r.fecha_hora, r.estado FROM registros_acceso r LEFT JOIN usuarios u ON r.huella_id = u.huella_id ORDER BY r.fecha_hora DESC`;
        const resultado = await pool.query(query);
        res.json(resultado.rows); 
    } catch (err) { res.status(500).json({ error: "Error DB" }); }
});

// --- 9. CONTADOR ACCESOS HOY ---
app.get('/api/accesos-hoy', async (req, res) => {
    try {
        const query = `SELECT COUNT(*) FROM registros_acceso WHERE DATE(fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Tijuana') = DATE(CURRENT_TIMESTAMP AT TIME ZONE 'America/Tijuana')`;
        const resultado = await pool.query(query);
        res.json({ total: parseInt(resultado.rows[0].count, 10) });
    } catch (err) { res.status(500).json({ error: "Error DB" }); }
});

pool.connect().then(() => {
    console.log('✅ Conexión exitosa a AWS RDS');
    server.listen(PORT, () => { console.log(`🌐 Servidor BioAccess activo en puerto ${PORT}`); });
}).catch(err => console.error('❌ Error DB:', err.message));
