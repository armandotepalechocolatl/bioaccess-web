const express = require('express');
const { Pool } = require('pg');
const app = express();

// Usamos el puerto que asigne el entorno o el 3000 por defecto
const PORT = process.env.PORT || 3000;

// Configuración de la conexión a AWS RDS
const pool = new Pool({
    user: 'postgres',
    host: 'database-1.ct6ssasymo8y.mx-central-1.rds.amazonaws.com',
    database: 'bioaccess',
    password: 'AdminBio123',
    port: 5432,
    // ESTO ES LO QUE FALTA PARA AWS:
    ssl: {
        rejectUnauthorized: false
    }
});

app.use(express.static('public'));
app.use(express.json());

// 1. RUTA PARA REGISTRAR USUARIOS
app.post('/api/registrar-usuario', async (req, res) => {
    const { nombre, departamento, huella_id } = req.body;
    try {
        await pool.query(
            'INSERT INTO usuarios (nombre, departamento, huella_id) VALUES ($1, $2, $3)', 
            [nombre, departamento, huella_id]
        );
        console.log(`✅ Usuario ${nombre} guardado en AWS.`);
        res.status(200).json({ mensaje: 'Usuario guardado' });
    } catch (err) {
        console.error("❌ Error en INSERT:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. RUTA PARA LISTAR USUARIOS
app.get('/api/lista-usuarios', async (req, res) => {
    try {
        // Seleccionamos los últimos 10 ordenados por su ID de creación de forma descendente
        const resultado = await pool.query('SELECT * FROM usuarios ORDER BY id_usuario DESC LIMIT 10');
        res.json(resultado.rows);
    } catch (err) {
        res.status(500).json({ error: "Error al obtener usuarios" });
    }
});

// 4. RUTA PARA ELIMINAR USUARIOS
app.delete('/api/eliminar-usuario/:id', async (req, res) => {
    const id = req.params.id;
    try {
        // Paso 1: Eliminar el historial de accesos de este usuario para que Postgres no bloquee el borrado
        await pool.query('DELETE FROM registros_acceso WHERE huella_id = $1', [id]);
        
        // Paso 2: Ahora sí, eliminar al usuario de la tabla principal
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

// 3. RUTA PARA EL HISTORIAL (DASHBOARD)
app.get('/api/historial', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM registros_acceso ORDER BY fecha_hora DESC LIMIT 10');
        res.json(resultado.rows); 
    } catch (err) {
        console.error("❌ Error al consultar historial en AWS:", err.message);
        res.status(500).json({ error: "Error al consultar la base de datos" });
    }
});

// 5. RUTA PARA LOGIN (Validando desde la Base de Datos AWS)
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    
    try {
        // Convertimos el usuario (texto) a número entero para que coincida con la base de datos
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

// 6. RUTA PARA EL HISTORIAL COMPLETO (Con Departamentos)
app.get('/api/historial-completo', async (req, res) => {
    try {
        // Hacemos un JOIN para combinar el registro de acceso con el departamento del usuario
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

// 7. RUTA PARA REGISTRAR ACCESOS DESDE EL ESP32
app.post('/api/registrar-acceso', async (req, res) => {
    // 1. Extraemos los datos que mandó el ESP32
    const { huella_id, nombre, estado } = req.body;
    
    try {
        // 2. Insertamos el registro en la tabla de PostgreSQL
        await pool.query(
            'INSERT INTO registros_acceso (huella_id, nombre, estado) VALUES ($1, $2, $3)',
            [huella_id, nombre, estado]
        );
        
        console.log(`✅ Acceso registrado desde el ESP32 para: ${nombre}`);
        
        // 3. Respondemos al ESP32 con un 200 OK para confirmar la entrega
        res.status(200).json({ mensaje: "Acceso registrado correctamente" });
        
    } catch (err) {
        console.error("❌ Error al guardar el acceso:", err.message);
        res.status(500).json({ error: "Error interno en la base de datos" });
    }
});

// Conectar a la base de datos y encender el servidor UNA SOLA VEZ
pool.connect()
    .then(() => {
        console.log('✅ Conexión exitosa a AWS RDS');
        app.listen(PORT, () => {
            console.log(`🌐 Servidor BioAccess activo en puerto ${PORT}`);
        });
    })
    .catch(err => console.error('❌ Error fatal al conectar a la DB:', err.message));
