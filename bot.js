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
        try { this.bot.quit() } catch (_) {}
      }

      this.bot = mineflayer.createBot({
        host,
        port: parseInt(port) || 25565,
        username,
        auth: 'offline',
        hideErrors: true,
        plugins: [pathfinder, pvp]
      })
    } catch (err) {
      this.log(`❌ Creation failed: ${err.message}`)
      this._scheduleReconnect()
      return
    }

    this.bot.once('spawn', () => {
      this.connected = true
      this.reconnectAttempts = 0
      this.log(`✅ Bot joined the server!`)
      this.log(`📍 Position: ${this._posStr()}`)
      this.emit('status', this.getStatus())
      
      // Start the main loop
      if (this.loopTimeout) clearTimeout(this.loopTimeout)
      this._loop()
    })

    this.bot.on('health', () => this.emit('status', this.getStatus()))

    this.bot.on('kicked', (reason) => {
      const msg = typeof reason === 'object' ? JSON.stringify(reason) : reason
      this.log(`🚫 Kicked from server: ${msg}`)
      this.connected = false
      this._scheduleReconnect()
    })

    this.bot.on('error', (err) => {
      this.log(`❌ Error: ${err.message}`)
      if (!this.connected) this._scheduleReconnect()
    })

    this.bot.on('end', (reason) => {
      this.log(`🔌 Disconnected (end): ${reason || 'unknown'}`)
      this.connected = false
      this._scheduleReconnect()
    })

    this.bot.on('chat', (username, message) => {
      if (username !== this.bot.username) {
        this.log(`💬 <${username}> ${message}`)
      }
    })

    // --- Revenge Logic ---
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

    this.bot.on('death', () => {
      this.log('💀 Bot died! Waiting for respawn...')
      this.bot.pvp.stop()
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
          
          // Set movements for pathfinding
          const defaultMove = new Movements(this.bot)
          this.bot.pathfinder.setMovements(defaultMove)

          // Start PVP attack
          this.bot.pvp.attack(target)
          
          // Pathfinder to stay close
          const goal = new goals.GoalFollow(target, 2)
          this.bot.pathfinder.setGoal(goal, true)

          // Loop faster while hunting
          this.loopTimeout = setTimeout(() => this._loop(), 500)
          return
        } else {
          // Target is not in render distance or offline
          this.log(`🔍 Searching for ${this.targetPlayer}... (not in sight)`)
          this.bot.pvp.stop()
        }
      }

      // Check nearby players — go idle to be less suspicious
      const nearbyEntities = Object.values(this.bot.players)
        .filter(p => p.entity && p.username !== this.bot.username)
      if (nearbyEntities.length > 0) {
        this.log(`👀 ${nearbyEntities.length} player(s) nearby → idling`)
        this.loopTimeout = setTimeout(() => this._loop(), this._rand(6000, 12000))
        return
      }

      const action = Math.random()

      if (action < 0.30) {
        // Look around randomly
        this.bot.look(
          Math.random() * Math.PI * 2,
          (Math.random() * Math.PI) - (Math.PI / 2),
          true
        )
        this.log('👁️  Looking around')
        await this._sleep(this._rand(800, 2000))

      } else if (action < 0.55) {
        // Walk in a random direction
        const yaw = Math.random() * Math.PI * 2
        this.bot.look(yaw, 0, true)
        this.bot.setControlState('forward', true)
        if (Math.random() < 0.2) {
          this.bot.setControlState('sprint', true)
          this.log('🏃 Sprinting')
        } else {
          this.log('🚶 Walking')
        }
        await this._sleep(this._rand(1500, 4000))
        this.bot.clearControlStates()

      } else if (action < 0.70) {
        // Mine the block below
        const block = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0))
        if (block && this.bot.canDigBlock(block)) {
          this.log(`⛏️  Mining ${block.name}`)
          await this.bot.dig(block)
        } else {
          this.log('⛏️  Nothing to mine here')
        }

      } else if (action < 0.80) {
        // Jump
        this.bot.setControlState('jump', true)
        this.log('🦘 Jumping')
        await this._sleep(500)
        this.bot.setControlState('jump', false)

      } else if (action < 0.88) {
        // Sneak for a bit
        this.bot.setControlState('sneak', true)
        this.bot.setControlState('forward', true)
        this.log('🥷 Sneaking')
        await this._sleep(this._rand(2000, 5000))
        this.bot.clearControlStates()

      } else {
        // Active Idle — stand still but mimic life
        const idleTime = this._rand(5000, 20000)
        this.log(`😴 Active idle (${Math.round(idleTime / 1000)}s)...`)
        
        // Split idle into chunks to perform tiny actions
        const chunks = Math.floor(idleTime / 2000)
        for(let i=0; i<chunks; i++) {
          if(!this.connected) break
          // Small look adjustment
          if(Math.random() < 0.3) {
            this.bot.look(
              this.bot.entity.yaw + (Math.random() - 0.5) * 0.2,
              this.bot.entity.pitch + (Math.random() - 0.5) * 0.2,
              true
            )
          }
          // Arm swing
          if(Math.random() < 0.2) this.bot.swingArm('right')
          await this._sleep(2000)
        }
      }

      // Emit status after every action
      this.emit('status', this.getStatus())

    } catch (err) {
      this.log(`⚠ Loop error: ${err.message}`)
    }

    if (this.shouldBeRunning && this.connected) {
      this.loopTimeout = setTimeout(() => this._loop(), this._rand(1000, 4000))
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
