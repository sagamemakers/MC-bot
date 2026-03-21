const mineflayer = require('mineflayer')
const EventEmitter = require('events')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin

class BotManager extends EventEmitter {
  constructor() {
    super()
    this.bot = null
    this.running = false
    this.config = null
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.loopTimeout = null
    this.reconnectTimeout = null
    this.targetPlayer = null // Username of the player to hunt
  }

  log(msg) {
    const timestamp = new Date().toLocaleTimeString()
    const entry = `[${timestamp}] ${msg}`
    console.log(entry)
    this.emit('log', entry)
  }

  getStatus() {
    if (!this.bot || !this.running) {
      return { online: false }
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
    if (this.running) {
      this.log('⚠ Bot is already running. Stop it first.')
      return
    }
    this.config = config
    this.reconnectAttempts = 0
    this._createBot()
  }

  stop() {
    this.log('🛑 Stopping bot...')
    this.running = false
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
    const { host, port, username } = this.config
    this.log(`🔗 Connecting to ${host}:${port} as "${username}"...`)

    try {
      this.bot = mineflayer.createBot({
        host,
        port: parseInt(port) || 25565,
        username,
        auth: 'offline',
        hideErrors: false
      })
    } catch (err) {
      this.log(`❌ Failed to create bot: ${err.message}`)
      this._scheduleReconnect()
      return
    }

    // Load plugins
    this.bot.loadPlugin(pathfinder)
    this.bot.loadPlugin(pvp)

    this.bot.once('spawn', () => {
      this.running = true
      this.reconnectAttempts = 0
      this.log(`✅ Bot joined the server!`)
      this.log(`📍 Position: ${this._posStr()}`)
      this.log(`❤️  Health: ${this.bot.health} | 🍖 Food: ${this.bot.food}`)
      this.emit('status', this.getStatus())
      this.loopTimeout = setTimeout(() => this._loop(), 3000)
    })

    this.bot.on('health', () => {
      this.emit('status', this.getStatus())
    })

    this.bot.on('playerJoined', (player) => {
      this.log(`👤 Player joined: ${player.username}`)
      this.emit('status', this.getStatus())
    })

    this.bot.on('playerLeft', (player) => {
      this.log(`👤 Player left: ${player.username}`)
      this.emit('status', this.getStatus())
    })


    this.bot.on('kicked', (reason) => {
      const msg = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.log(`🚫 Kicked: ${msg}`)
      this.running = false
      
      const permanentErrors = [
        'Invalid characters in username',
        'is not white-listed',
        'Banned from this server',
        'The server is full'
      ]

      if (permanentErrors.some(err => msg.includes(err))) {
        this.log('🛑 Permanent error detected. Stopping bot.')
        this.stop()
      } else {
        this._scheduleReconnect()
      }
    })

    this.bot.on('error', (err) => {
      this.log(`❌ Error: ${err.message}`)
    })

    this.bot.on('end', (reason) => {
      if (this.running) {
        this.log(`🔌 Disconnected: ${reason || 'unknown'}`)
        this.running = false
        this._scheduleReconnect()
      }
    })

    this.bot.on('chat', (username, message) => {
      if (username !== this.bot.username) {
        this.log(`💬 <${username}> ${message}`)
      }
    })

    // --- Revenge/Stalker Logic ---
    this.bot.on('entityHurt', (entity) => {
      if (entity !== this.bot.entity) return

      // Look for the attacker
      const attacker = this.bot.nearestEntity(e => 
        e.type === 'player' && 
        e.username !== this.bot.username &&
        this.bot.entity.position.distanceTo(e.position) < 10
      )

      if (attacker && attacker.username) {
        if (this.targetPlayer !== attacker.username) {
          this.targetPlayer = attacker.username
          this.log(`🎯 TARGET ACQUIRED: ${attacker.username}. I will hunt him down.`)
          this.bot.chat(`I see you, ${attacker.username}. You'll regret that.`)
          // Trigger loop immediately to start the hunt
          if (this.loopTimeout) clearTimeout(this.loopTimeout)
          this._loop()
        }
      }
    })

    this.bot.on('playerLeft', (player) => {
      this.log(`👤 Player left: ${player.username}`)
      if (this.targetPlayer === player.username) {
        this.log(`🕵️ Target ${player.username} left. Waiting for them to return...`)
      }
      this.emit('status', this.getStatus())
    })

    this.bot.on('death', () => {
      this.log('💀 Bot died! Waiting to respawn...')
      if (this.targetPlayer) {
        this.log(`🏹 Still haunting ${this.targetPlayer}... will resume after respawn.`)
      }
      this.bot.pvp.stop() // Stop pvp logic on death
    })
  }

  chat(message) {
    if (!this.bot || !this.running) return
    this.log(`📤 Sending: ${message}`)
    this.bot.chat(message)
  }

  _posStr() {
    if (!this.bot?.entity) return '?'
    const p = this.bot.entity.position
    return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(`❌ Max reconnect attempts reached (${this.maxReconnectAttempts}). Giving up.`)
      this.emit('status', this.getStatus())
      return
    }
    this.reconnectAttempts++
    // Exponential backoff: 5s, 10s, 20s, 40s... capped at 120s
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 120000)
    this.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)
  }

  async _loop() {
    if (!this.running || !this.bot) return

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
        // Idle break — stand still
        const idleTime = this._rand(5000, 20000)
        this.log(`😴 Idle break (${Math.round(idleTime / 1000)}s)`)
        await this._sleep(idleTime)
      }

      // Emit status after every action
      this.emit('status', this.getStatus())

    } catch (err) {
      this.log(`⚠ Loop error: ${err.message}`)
    }

    if (this.running) {
      this.loopTimeout = setTimeout(() => this._loop(), this._rand(1000, 4000))
    }
  }

  _sleep(ms) {
    return new Promise(res => setTimeout(res, ms))
  }

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min) + min)
  }
}

module.exports = BotManager
