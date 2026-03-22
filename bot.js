const mineflayer = require('mineflayer')
const EventEmitter = require('events')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin

class BotManager extends EventEmitter {
  constructor() {
    super()
    this.bot = null
    this.shouldBeRunning = false // Tracks if the user wants the bot to be active
    this.connected = false // Tracks if the bot is currently in-game
    this.config = null
    this.reconnectAttempts = 0
    this.reconnectTimeout = null
    this.loopTimeout = null
    this.targetPlayer = null 
  }

  log(msg) {
    const timestamp = new Date().toLocaleTimeString()
    const entry = `[${timestamp}] ${msg}`
    console.log(entry)
    this.emit('log', entry)
  }

  getStatus() {
    if (!this.bot || !this.connected) {
      return { online: false, status: this.shouldBeRunning ? 'Reconnecting...' : 'Stopped' }
    }
    const b = this.bot
    const players = Object.values(b.players || {})
      .filter(p => p.entity && p.username !== b.username)
      .map(p => p.username)

    return {
      online: true,
      username: b.username,
      health: b.health ?? 0,
      food: b.food ?? 0,
      position: b.entity ? {
        x: Math.round(b.entity.position.x),
        y: Math.round(b.entity.position.y),
        z: Math.round(b.entity.position.z)
      } : null,
      gameMode: b.game?.gameMode ?? 'unknown',
      nearbyPlayers: players,
      ping: b.player?.ping ?? 0,
      dimension: b.game?.dimension ?? 'unknown',
      difficulty: b.game?.difficulty ?? 'unknown',
      serverBrand: b.game?.serverBrand ?? 'unknown'
    }
  }

  start(config) {
    this.config = config
    this.shouldBeRunning = true
    this.reconnectAttempts = 0
    this._createBot()
  }

  stop() {
    this.log('🛑 Stopping bot...')
    this.shouldBeRunning = false
    this.connected = false
    if (this.loopTimeout) clearTimeout(this.loopTimeout)
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
    if (this.bot) {
      try { this.bot.quit() } catch (_) {}
      this.bot = null
    }
    this.emit('status', this.getStatus())
    this.log('✅ Bot stopped.')
  }

  _createBot() {
    if (!this.shouldBeRunning) return
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)

    const { host, port, username } = this.config
    this.log(`🔗 Connecting to ${host}:${port} as "${username}"...`)

    try {
      if (this.bot) {
        this.bot.removeAllListeners()
        try { this.bot.quit() } catch (_) {}
      }

      this.bot = mineflayer.createBot({
        host,
        port: parseInt(port) || 25565,
        username,
        auth: 'offline',
        hideErrors: true,
        plugins: [pathfinder, pvp],
        checkTimeoutInterval: 45000 // Detect silent timeouts faster (45s)
      })
    } catch (err) {
      this.log(`❌ Creation failed: ${err.message}`)
      this._scheduleReconnect()
      return
    }

    this.bot.on('error', (err) => {
      this.log(`❌ Error: ${err.message}`)
      // If it fails to even connect, try again
      if (!this.connected) {
        this.log('🔄 Connection failed. Retrying...')
        this._scheduleReconnect()
      }
    })

    this.bot.on('end', (reason) => {
      this.log(`🔌 Ended: ${reason || 'unknown'}`)
      this.connected = false
      this._scheduleReconnect()
    })

    // Safety timeout: If it doesn't spawn in 2 minutes, try again
    const spawnTimeout = setTimeout(() => {
      if (!this.connected && this.shouldBeRunning) {
        this.log('🕙 Spawn timeout (2m). Retrying connection...')
        if (this.bot) this.bot.quit()
        this._scheduleReconnect()
      }
    }, 120000)

    this.bot.once('spawn', () => {
      clearTimeout(spawnTimeout)
      this.connected = true
      this.reconnectAttempts = 0
      this.log(`✅ Bot joined! Server: ${this.bot.game?.serverBrand || 'vanilla'}`)
      this.log(`📍 Position: ${this._posStr()}`)
      this.emit('status', this.getStatus())
      if (this.loopTimeout) clearTimeout(this.loopTimeout)
      this._loop()
    })

    this.bot.on('health', () => this.emit('status', this.getStatus()))

    this.bot.on('kicked', (reason) => {
      this.log(`🚫 Kicked: ${typeof reason === 'object' ? JSON.stringify(reason) : reason}`)
      this.connected = false
      this._scheduleReconnect()
    })

    this.bot.on('death', () => {
      this.log('💀 Died. Respawning...')
      this.bot.pvp.stop()
    })

    this.bot.on('chat', (username, message) => {
      if (username !== this.bot.username) {
        this.log(`💬 <${username}> ${message}`)
      }
    })

    this.bot.on('entityHurt', (entity) => {
      if (entity !== this.bot.entity) return
      const attacker = this.bot.nearestEntity(e => 
        e.type === 'player' && e.username !== this.bot.username &&
        this.bot.entity.position.distanceTo(e.position) < 10
      )
      if (attacker && attacker.username && this.targetPlayer !== attacker.username) {
        this.targetPlayer = attacker.username
        this.log(`🎯 TARGET ACQUIRED: ${attacker.username}. Hunting...`)
        this.bot.chat(`I see you, ${attacker.username}. You'll regret that.`)
      }
    })
  }

  _scheduleReconnect() {
    if (!this.shouldBeRunning) return
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)

    this.reconnectAttempts++
    // Delay: starts at 5s, doubles up to 60s
    const delay = Math.min(5000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 4)), 60000)
    
    this.log(`🔄 Reconnect attempt ${this.reconnectAttempts} in ${delay/1000}s...`)
    this.reconnectTimeout = setTimeout(() => {
      if (this.shouldBeRunning && !this.connected) {
        this._createBot()
      }
    }, delay)
  }

  _posStr() {
    if (!this.bot?.entity) return '?'
    const p = this.bot.entity.position
    return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`
  }

  async _loop() {
    if (!this.shouldBeRunning || !this.connected || !this.bot) return

    try {
      // --- STALKER LOGIC OVERRIDE ---
      if (this.targetPlayer) {
        const target = this.bot.players[this.targetPlayer]?.entity
        if (target) {
          this.log(`🏹 Hunting ${this.targetPlayer}...`)
          const defaultMove = new Movements(this.bot)
          this.bot.pathfinder.setMovements(defaultMove)
          this.bot.pvp.attack(target)
          this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
          this.loopTimeout = setTimeout(() => this._loop(), 500)
          return
        } else {
          this.log(`🔍 Searching for ${this.targetPlayer}... (not in sight)`)
          this.bot.pvp.stop()
        }
      }

      // --- RANDOM ACTION SELECTION ---
      const action = Math.random()

      if (action < 0.15) {
        // --- ACTIVE MOVEMENT (Best for Anti-AFK) ---
        const x = (Math.random() - 0.5) * 10
        const z = (Math.random() - 0.5) * 10
        const goalPos = this.bot.entity.position.offset(x, 0, z)
        this.log(`🚶 Relocating to ensure activity...`)
        
        const defaultMove = new Movements(this.bot)
        this.bot.pathfinder.setMovements(defaultMove)
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(goalPos.x, goalPos.y, goalPos.z, 1))
        } catch (err) {}

      } else if (action < 0.35) {
        // --- LOOK AROUND ---
        this.bot.look(Math.random() * Math.PI * 2, (Math.random() * Math.PI) - (Math.PI / 2), true)
        this.log('👁️  Scanning environment')
        await this._sleep(this._rand(1000, 3000))

      } else if (action < 0.45) {
        // --- TAB COMPLETE HEARTBEAT (Bypasses some bot detectors) ---
        try {
          const players = Object.keys(this.bot.players)
          const randomPlayer = players[Math.floor(Math.random() * players.length)]
          if (randomPlayer) {
            this.log(`📡 Sending heartbeat signal...`)
            await this.bot.tabComplete(randomPlayer)
          }
        } catch (err) {}

      } else if (action < 0.55) {
        // --- SWING & JUMP ---
        this.log('🦘 Testing reflexes')
        this.bot.setControlState('jump', true)
        this.bot.swingArm('right')
        await this._sleep(400)
        this.bot.setControlState('jump', false)

      } else if (action < 0.60 && Math.random() < 0.1) {
        // --- PERIODIC KEEP-ALIVE CHAT (Rare) ---
        const messages = ["", "...", ".", "hey", "sup", "yo"]
        const msg = messages[Math.floor(Math.random() * messages.length)]
        if (msg) {
          this.log(`💬 Anti-AFK Chat: ${msg}`)
          this.bot.chat(msg)
        }

      } else {
        // --- MICRO-IDLE ---
        const idleTime = this._rand(5000, 15000)
        this.log(`😴 Micro-nap (${Math.round(idleTime / 1000)}s)`)
        
        const chunks = Math.floor(idleTime / 2000)
        for(let i=0; i<chunks; i++) {
          if(!this.connected) break
          if(Math.random() < 0.2) this.bot.swingArm('right')
          await this._sleep(2000)
        }
      }

      this.emit('status', this.getStatus())

    } catch (err) {
      this.log(`⚠ Loop error: ${err.message}`)
    }

    if (this.shouldBeRunning && this.connected) {
      this.loopTimeout = setTimeout(() => this._loop(), this._rand(2000, 5000))
    }
  }

  chat(message) {
    if (!this.bot || !this.connected) return
    this.log(`📤 Sending: ${message}`)
    this.bot.chat(message)
  }

  _sleep(ms) {
    return new Promise(res => setTimeout(res, ms))
  }

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min) + min)
  }
}

module.exports = BotManager
