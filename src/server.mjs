

import express from "express";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getArgs = () =>
  process.argv.reduce((args, arg) => {
    // long arg
    if (arg.slice(0, 2) === "--") {
      const longArg = arg.split("=");
      const longArgFlag = longArg[0].slice(2);
      const longArgValue = longArg.length > 1 ? longArg[1] : true;
      args[longArgFlag] = longArgValue;
    }
    // flags
    else if (arg[0] === "-") {
      const flags = arg.slice(1).split("");
      flags.forEach((flag) => {
        args[flag] = true;
      });
    }
    return args;
  }, {});

const args = getArgs();

// Fonction pour charger la config d'un salon
function loadConfig(salon) {
  const configPath = path.join(__dirname, "../streams", salon, "config.json");
  if (!fs.existsSync(configPath)) {
    // Créer config par défaut
    const defaultConfig = {
      active: false,
      streamkitUrl: "",
      background: "#000",
      defaultImage: "images/default.svg",
      name: salon,
      participants: [],
      participantDefaults: {},
      // Nouveaux paramètres globaux pour les effets visuels
      globalVisualEffects: {
        useGrayscale: true,
        silentBorderColor: "#666666",
        speakingBorderColor: "#00ff00",
        borderWidth: 3
      }
    };
    fs.mkdirSync(path.join(__dirname, "../streams", salon), { recursive: true });
    fs.mkdirSync(path.join(__dirname, "../streams", salon, "images"), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// Map pour tracker les streams actifs : salon -> { browser, page, interval, config }
const activeStreams = new Map();

async function startStreamPuppeteer(salon) {
  if (activeStreams.has(salon)) {
    console.log(`Stream ${salon} déjà actif`);
    return;
  }

  const config = loadConfig(salon);
  if (!config.streamkitUrl) {
    console.log(`Pas d'URL StreamKit pour ${salon}`);
    return;
  }

  console.log(`Démarrage du stream ${salon}...`);

  let browser = null;
  let launchOptions = { headless: config.headless === true }; // Headless seulement si explicitement demandé
  console.log(`Mode navigateur: ${launchOptions.headless ? 'headless' : 'avec fenêtre visible'}`);
  
  if (!launchOptions.headless) {
    // Arguments pour rendre la fenêtre visible et accessible
    launchOptions.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1200,800',
      '--window-position=0,0'
    ];
  }
  
  try {
    browser = await puppeteer.launch(launchOptions);
    console.log(`Navigateur lancé pour ${salon}`);
  } catch (e) {
    console.error(`Erreur lors du lancement du navigateur pour ${salon}:`, e.message);
    return;
  }

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    console.log(`[${salon}] Chargement de ${config.streamkitUrl}...`);
    await page.goto(config.streamkitUrl, { waitUntil: "load" }).catch(e => console.log(`Timeout load, continuant...`));

    // Wait pour le contenu
    try {
      await page.waitForSelector("ul.voice_states", { timeout: 5000 });
      console.log(`[${salon}] Sélecteur ul.voice_states détecté`);
    } catch (e) {
      console.log(`[${salon}] Sélecteur non trouvé, continuant...`);
    }

    // Écouter les événements de fermeture du navigateur/page
    browser.on('disconnected', () => {
      console.log(`[${salon}] Navigateur déconnecté, arrêt automatique du stream`);
      stopStreamPuppeteer(salon);
    });

    page.on('close', () => {
      console.log(`[${salon}] Page fermée, arrêt automatique du stream`);
      stopStreamPuppeteer(salon);
    });

    page.on('framedetached', (frame) => {
      console.log(`[${salon}] Frame détachée: ${frame._id}, arrêt automatique du stream`);
      stopStreamPuppeteer(salon);
    });

    // Polling interval
    const interval = setInterval(async () => {
      try {
        const users = await page.evaluate(() => {
          const items = [...document.querySelectorAll("li.voice_state")];
          return items.map(item => {
            const nameEl = item.querySelector("span.Voice_name__TALd9");
            const avatarEl = item.querySelector("img.voice_avatar");
            const stableId = item.getAttribute("data-user-id") || item.dataset.userId || item.id;
            const classList = Array.from(item.classList).join(" ").toLowerCase();
            const speaking = classList.includes("speak") || classList.includes("talk") || classList.includes("active");
            const name = nameEl?.textContent?.trim() || stableId || "";
            
            return {
              id: stableId || name,
              name,
              avatar: avatarEl?.src || "",
              speaking,
              muted: item.classList.contains("self_mute") || item.classList.contains("deaf")
            };
          });
        });

        broadcastToSalon(salon, { type: "voiceState", users, salon });
      } catch (e) {
        console.error(`[${salon}] Erreur polling:`, e.message);
      }
    }, 500);

    activeStreams.set(salon, { browser, page, interval, config });
    console.log(`✓ Stream ${salon} démarré`);
  } catch (e) {
    await browser.close();
    console.error(`Erreur setup stream ${salon}:`, e.message);
  }
}

async function stopStreamPuppeteer(salon) {
  if (!activeStreams.has(salon)) return;
  
  const stream = activeStreams.get(salon);
  if (stream.stopping) return; // Éviter les appels multiples
  stream.stopping = true;
  
  clearInterval(stream.interval);
  
  try {
    await stream.browser.close();
  } catch (e) {
    console.log(`[${salon}] Browser déjà fermé:`, e.message);
  }
  
  activeStreams.delete(salon);
  console.log(`✓ Stream ${salon} arrêté`);
}

const app = express();
const PORT = args.port || 3000;

app.use(express.json());

const server = app.listen(PORT, () => {
  console.log(`Serveur HTTP sur http://localhost:${PORT}`);
});

// WebSocket pour pousser l'état vocal au front
const wss = new WebSocketServer({ server });

// Tracker les clients WebSocket par salon
const clientsBySalon = new Map(); // salon -> Set(clients)

function broadcastToSalon(salon, data) {
  const msg = JSON.stringify(data);
  if (clientsBySalon.has(salon)) {
    clientsBySalon.get(salon).forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }
}

// Quand un client se connecte
wss.on('connection', (ws) => {
  let clientSalon = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Si c'est un message pour se connecter à un salon
      if (data.type === 'subscribe') {
        const newSalon = data.salon;
        
        // Se déconnecter de l'ancien salon
        if (clientSalon && clientsBySalon.has(clientSalon)) {
          clientsBySalon.get(clientSalon).delete(ws);
          if (clientsBySalon.get(clientSalon).size === 0) {
            clientsBySalon.delete(clientSalon);
          }
        }
        
        // Se connecter au nouveau salon
        clientSalon = newSalon;
        if (!clientsBySalon.has(clientSalon)) {
          clientsBySalon.set(clientSalon, new Set());
        }
        clientsBySalon.get(clientSalon).add(ws);
        console.log(`Client connecté au salon ${clientSalon}`);
      }
    } catch (err) {
      console.error('Erreur WebSocket:', err);
    }
  });

  ws.on('close', () => {
    if (clientSalon && clientsBySalon.has(clientSalon)) {
      clientsBySalon.get(clientSalon).delete(ws);
      if (clientsBySalon.get(clientSalon).size === 0) {
        clientsBySalon.delete(clientSalon);
      }
    }
  });
});

// Routes principales (AVANT les fichiers statiques)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/:salon/show", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).send("Salon invalide");
  
  // Auto-activer le stream si pas actif
  const config = loadConfig(salon);
  if (!config.active) {
    config.active = true;
    const configPath = path.join(__dirname, "../streams", salon, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    startStreamPuppeteer(salon);
  }
  
  res.sendFile(path.join(__dirname, "public", "show.html"));
});

app.get("/:salon", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).send("Salon invalide");
  
  // Auto-activer le stream si pas actif
  const config = loadConfig(salon);
  if (!config.active) {
    config.active = true;
    const configPath = path.join(__dirname, "../streams", salon, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    startStreamPuppeteer(salon);
  }
  
  res.sendFile(path.join(__dirname, "public", "config.html"));
});

// Servir les fichiers statiques (images, etc.) - APRÈS les routes dynamiques
app.use(express.static(path.join(__dirname, "public")));

// Route pour les images par salon
app.get('/images/:salon/:filename', (req, res) => {
  const { salon, filename } = req.params;
  const filePath = path.join(__dirname, "../streams", salon, "images", filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Image not found');
  }
});

// Route pour lister les streams
app.get("/api/streams", (req, res) => {
  const streamsDir = path.join(__dirname, "../streams");
  const streams = [];
  if (fs.existsSync(streamsDir)) {
    const folders = fs.readdirSync(streamsDir).filter(f => fs.statSync(path.join(streamsDir, f)).isDirectory());
    for (const folder of folders) {
      const configPath = path.join(streamsDir, folder, "config.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath));
        streams.push({ id: folder, name: config.name || folder, active: config.active || false });
      }
    }
  }
  res.json(streams);
});

// Route pour créer un stream
app.post("/api/streams", (req, res) => {
  const { id, name, streamkitUrl } = req.body;
  if (!id || !name) return res.status(400).json({ error: "ID et nom requis" });
  const streamDir = path.join(__dirname, "../streams", id);
  if (fs.existsSync(streamDir)) return res.status(400).json({ error: "Stream existe déjà" });
  fs.mkdirSync(streamDir);
  fs.mkdirSync(path.join(streamDir, "images"));
  const config = { 
    streamkitUrl: streamkitUrl || "", 
    background: "#000", 
    defaultImage: "images/default.svg", 
    name, 
    participants: [], 
    participantDefaults: {} 
  };
  fs.writeFileSync(path.join(streamDir, "config.json"), JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// Route pour supprimer un stream
app.delete("/api/streams/:salon", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).json({ error: "Salon invalide" });
  const streamDir = path.join(__dirname, "../streams", salon);
  if (fs.existsSync(streamDir)) {
    fs.rmSync(streamDir, { recursive: true });
  }
  res.json({ success: true });
});

// Endpoint pour récupérer la config côté front
app.get("/api/:salon/config", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).json({ error: "Salon invalide" });
  
  const config = loadConfig(salon);
  
  // Si le stream doit être actif et n'est pas lancé, le démarrer
  if (config.active && !activeStreams.has(salon)) {
    startStreamPuppeteer(salon);
  }
  
  res.json(config);
});

// Endpoint pour toggler le stream (active/inactive)
app.post("/api/:salon/toggle-stream", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).json({ error: "Salon invalide" });
  
  const config = loadConfig(salon);
  config.active = !config.active;
  
  const configPath = path.join(__dirname, "../streams", salon, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  if (config.active) {
    startStreamPuppeteer(salon);
  } else {
    stopStreamPuppeteer(salon);
  }
  
  res.json({ active: config.active, success: true });
});

// Endpoint pour sauvegarder la config
app.post("/api/:salon/config", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).json({ error: "Salon invalide" });
  const configPath = path.join(__dirname, "../streams", salon, "config.json");
  let config = loadConfig(salon);
  
  // Garder la valeur "active" si elle n'est pas fournie
  if (req.body.active === undefined) {
    req.body.active = config.active;
  }
  
  Object.assign(config, req.body);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Envoyer UNIQUEMENT aux clients du salon
  broadcastToSalon(salon, { type: "configUpdate", config, salon });
  res.json({ success: true });
});

// Endpoint pour uploader une image de participant
app.post("/api/:salon/upload-image", (req, res) => {
  const { salon } = req.params;
  if (!salon || salon === 'null' || salon === 'undefined') return res.status(400).json({ error: "Salon invalide" });
  const { data, name } = req.body;
  if (!data || !name) {
    return res.status(400).json({ error: "Données d'image manquantes" });
  }

  const match = data.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Format d'image invalide" });
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const ext = path.extname(name) || "";
  const safeExt = ext || mimeType.split("/")[1] || "png";
  const imagesDir = path.join(__dirname, "../streams", salon, "images");
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  const fileName = `upload-${Date.now()}.${safeExt.replace(/[^a-z0-9]/gi, "")}`;
  const filePath = path.join(imagesDir, fileName);

  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  res.json({ path: `/images/${salon}/${fileName}` });
});


