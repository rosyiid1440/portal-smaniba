const express = require('express');
const session = require('express-session');
const Keycloak = require('keycloak-connect');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = 4000;

// =============================================================================
// Data Store (using a simple JSON file)
// =============================================================================
const APPS_DB_PATH = path.join(__dirname, 'data', 'apps.json');

// Ensure data directory and file exist
// Ganti fungsi initDataStore yang lama dengan yang ini
const initDataStore = async () => {
    try {
        // Pastikan direktori 'data' ada
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

        let fileContent;
        try {
            // Coba baca file
            fileContent = await fs.readFile(APPS_DB_PATH, 'utf-8');
        } catch (error) {
            // Jika file tidak ada (ENOENT), itu tidak apa-apa, kita akan membuatnya.
            // Jika error lain, tampilkan.
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        // Jika file tidak ada ATAU isinya kosong, tulis data default
        if (!fileContent || fileContent.trim() === '') {
            console.log("File apps.json tidak ada atau kosong. Membuat file dengan data default...");
            const defaultApps = [
                {
                    "id": "1",
                    "name": "Aplikasi Akademik",
                    "url": "http://localhost:8000/auth/redirect",
                    "icon": "fa-graduation-cap",
                    "requiredRoles": ["user"]
                },
                {
                    "id": "2",
                    "name": "Aplikasi Keuangan",
                    "url": "http://localhost:3000/protected",
                    "icon": "fa-money-bill-wave",
                    "requiredRoles": ["user", "admin"]
                }
            ];
            await fs.writeFile(APPS_DB_PATH, JSON.stringify(defaultApps, null, 2));
        }

    } catch (error) {
        console.error("Terjadi kesalahan saat inisialisasi data store:", error);
        // Hentikan aplikasi jika gagal menginisialisasi database
        process.exit(1);
    }
};

// =============================================================================
// Keycloak & Session Configuration
// =============================================================================
const memoryStore = new session.MemoryStore();
app.use(session({
    secret: 'mySuperSecretKeyForSSO', // Ganti dengan secret yang lebih kuat
    resave: false,
    saveUninitialized: true,
    store: memoryStore
}));

// Inisialisasi Keycloak. Konfigurasi diambil dari file keycloak.json
const keycloak = new Keycloak({ store: memoryStore });

app.use(keycloak.middleware({
    logout: '/logout',
    admin: '/'
}));

// --- ADD THIS MIDDLEWARE TO CLEAN UP THE URL ---
app.use((req, res, next) => {
    // Check if the 'iss' query parameter exists, which indicates a redirect from Keycloak
    if (req.query.iss) {
        // Redirect to the same path but without any query parameters
        return res.redirect(req.path);
    }
    // If no 'iss' parameter, continue to the next middleware or route handler
    next();
});

// =============================================================================
// Express App Configuration
// =============================================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// Routes
// =============================================================================

// Halaman utama, langsung arahkan ke portal jika sudah login
app.get('/', (req, res) => {
    if (req.kauth.grant) {
        return res.redirect('/portal');
    }
    res.render('index');
});

// Portal utama untuk pengguna
// keycloak.protect() akan memaksa login jika belum ada sesi
app.get('/portal', keycloak.protect(), async (req, res) => {
    try {
        const allAppsData = await fs.readFile(APPS_DB_PATH);
        const allApps = JSON.parse(allAppsData);

        // Ambil peran pengguna dari token
        const userRoles = req.kauth.grant.access_token.content.realm_access.roles;
        const userName = req.kauth.grant.access_token.content.name;
        const isAdmin = userRoles.includes('admin');

        // Filter aplikasi berdasarkan peran pengguna
        const accessibleApps = allApps.filter(app =>
            app.requiredRoles.some(role => userRoles.includes(role))
        );

        res.render('portal', {
            apps: accessibleApps,
            userName: userName,
            isAdmin: isAdmin
        });
    } catch (error) {
        console.error("Error reading apps data:", error);
        res.status(500).send("Gagal memuat data aplikasi.");
    }
});

// Halaman Admin untuk mengelola aplikasi
// keycloak.protect('realm:admin') hanya mengizinkan pengguna dengan peran 'admin'
app.get('/admin', keycloak.protect('realm:admin'), async (req, res) => {
    try {
        const appsData = await fs.readFile(APPS_DB_PATH);
        const apps = JSON.parse(appsData);
        const userName = req.kauth.grant.access_token.content.name;

        res.render('admin', {
            apps: apps,
            userName: userName,
            isAdmin: true
        });
    } catch (error) {
        console.error("Error reading apps data for admin:", error);
        res.status(500).send("Gagal memuat data aplikasi.");
    }
});

// Proses penambahan aplikasi baru oleh Admin
app.post('/admin/add', keycloak.protect('realm:admin'), async (req, res) => {
    try {
        const { name, url, icon, requiredRoles } = req.body;
        const appsData = await fs.readFile(APPS_DB_PATH);
        const apps = JSON.parse(appsData);

        const newApp = {
            id: Date.now().toString(), // ID unik sederhana
            name,
            url,
            icon: icon || 'fa-cubes', // Icon default
            requiredRoles: requiredRoles.split(',').map(role => role.trim()).filter(Boolean)
        };

        apps.push(newApp);
        await fs.writeFile(APPS_DB_PATH, JSON.stringify(apps, null, 2));
        res.redirect('/admin');
    } catch (error) {
        console.error("Error adding new app:", error);
        res.status(500).send("Gagal menambahkan aplikasi.");
    }
});

// Proses penghapusan aplikasi oleh Admin
app.post('/admin/delete/:id', keycloak.protect('realm:admin'), async (req, res) => {
    try {
        const appId = req.params.id;
        const appsData = await fs.readFile(APPS_DB_PATH);
        let apps = JSON.parse(appsData);

        const filteredApps = apps.filter(app => app.id !== appId);

        await fs.writeFile(APPS_DB_PATH, JSON.stringify(filteredApps, null, 2));
        res.redirect('/admin');
    } catch (error) {
        console.error("Error deleting app:", error);
        res.status(500).send("Gagal menghapus aplikasi.");
    }
});

app.post('/admin/update/:id', keycloak.protect('realm:admin'), async (req, res) => {
    try {
        const appId = req.params.id;
        const { name, url, icon, requiredRoles } = req.body;
        const appsData = await fs.readFile(APPS_DB_PATH);
        let apps = JSON.parse(appsData);

        // Cari index dari aplikasi yang akan diupdate
        const appIndex = apps.findIndex(app => app.id === appId);

        // Jika aplikasi ditemukan, update datanya
        if (appIndex !== -1) {
            apps[appIndex].name = name;
            apps[appIndex].url = url;
            apps[appIndex].icon = icon || 'fa-cubes';
            apps[appIndex].requiredRoles = requiredRoles.split(',').map(role => role.trim()).filter(Boolean);
        } else {
            // Handle jika ID aplikasi tidak ditemukan
            return res.status(404).send("Aplikasi tidak ditemukan.");
        }

        // Tulis kembali data yang sudah diupdate ke file JSON
        await fs.writeFile(APPS_DB_PATH, JSON.stringify(apps, null, 2));
        res.redirect('/admin');

    } catch (error) {
        console.error("Error updating app:", error);
        res.status(500).send("Gagal memperbarui aplikasi.");
    }
});


// =============================================================================
// Start Server
// =============================================================================
initDataStore().then(() => {
    app.listen(port, () => {
        console.log(`🚀 Portal SSO berjalan di http://localhost:${port}`);
    });
});