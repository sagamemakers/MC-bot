const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')
const BotManager = require('./bot')
const fs = require('fs')
const path = require('path')

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

app.use(express.json())
app.use(express.static('public'))

const CONFIG_FILE = path.join(__dirname, 'bot-config.json')
const bot = new BotManager()

// --- Auto-start logic ---
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE))
      console.log('🤖 Auto-starting bot with saved config...')
      bot.start(config)
    } catch (err) {
      console.error('❌ Error loading bot-config.json:', err.message)
    }
  }
}
loadConfig()

// --- Broadcast to all WebSocket clients ---
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data })
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg)
  })
}

// Forward bot events to WebSocket clients
bot.on('log', (message) => broadcast('log', { message }))
bot.on('status', (status) => broadcast('status', status))

// --- REST API ---
app.post('/start', (req, res) => {
  const { host, port, username } = req.body
  if (!host || !username) {
    return res.status(400).json({ error: 'host and username are required' })
  }
  const config = { host, port: port || 25565, username }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config))
  bot.start(config)
  res.json({ success: true, message: 'Bot starting and config saved for persistence...' })
})

app.post('/stop', (req, res) => {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE)
  bot.stop()
  res.json({ success: true, message: 'Bot stopped and persistence cleared.' })
})

app.get('/status', (req, res) => {
  res.json(bot.getStatus())
})

// --- WebSocket connection ---
wss.on('connection', (ws) => {
  console.log('Dashboard client connected')
  // Send current status immediately
  ws.send(JSON.stringify({ type: 'status', data: bot.getStatus() }))

  ws.on('message', (msg) => {
    try {
      const { type, data } = JSON.parse(msg)
      if (type === 'chat' && data.message) {
        bot.chat(data.message)
      }
    } catch (err) {}
  })

  ws.on('close', () => console.log('Dashboard client disconnected'))
})

// --- Start server ---
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`\n  🎮 Minecraft Bot Dashboard`)
  console.log(`  ➜ http://localhost:${PORT}\n`)
})
