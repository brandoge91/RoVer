const path = require("path")
const Discord = require("discord.js-commando")
const request = require("request-promise")
const config = require("./data/client.json")
const DiscordServer = require("./DiscordServer")
const { Cache } = require("./GlobalCache")
const requestDebug = require("request-debug")
const SettingProvider = require("./commands/SettingProvider")
const Util = require("./Util")
const fs = require("mz/fs")

if (config.loud)
  requestDebug(request, (type, data) =>
    console.log(`${type} ${data.debugId} : ${data.uri || data.statusCode}`),
  )

const getUnauthorizedMessage = (member, server) =>
  `Sorry, this server isn't authorized to use RoVer Plus.\n\n${
    member.hasPermission(["MANAGE_GUILD"])
      ? "The server owner needs to get plus at <https://rover.link/plus>, or you can invite the regular RoVer bot at <https://RoVer.link>."
      : "**This isn't your fault, and there's nothing you can do** - please ask the server staff to update their RoVer Plus subscription."
  } \n\nUnauthorized reason: ${server.premiumReason}`

/**
 * The main Discord bot class, only one per shard.
 * @class DiscordBot
 */
class DiscordBot {
  constructor() {
    this.initialize()
    this.servers = {}
    this.blacklist = {}
  }

  /**
   * Initialize the bot, hook up events, and log in.
   * @memberof DiscordBot
   */
  initialize() {
    this.bot = new Discord.Client({
      owner: config.owner || "0",
      commandPrefix: config.commandPrefix || "!",
      unknownCommandResponse: false,
      disableMentions: "everyone",
      messageCacheMaxSize: 0,
      retryLimit: 0,
      ws: {
        intents: [
          "GUILD_MEMBERS",
          "GUILDS",
          "GUILD_MESSAGES",
          "DIRECT_MESSAGES",
        ],
      },
    })

    this.bot.setProvider(new SettingProvider())

    // Instantiate the shard's Cache singleton to interface with the main process.
    // A global variable is used here because the cache is dependent on the client
    // being initialized, but I don't like the idea of having to pass down the cache
    // from this object into every instance (DiscordMember, DiscordServer). This seemed
    // like the best solution.
    global.Cache = new Cache(this.bot)
    this.shardClientUtil = global.Cache.shardClientUtil

    // Set a reference to this instance inside of the client
    // for use in Commando modules. Is this bad? Probably.
    this.bot.discordBot = this

    // Events

    // We use .bind(this) so that the context remains within
    // the class and not the event.
    // this.bot.on('debug', (info) => { console.log(`[DEBUG SHARD${this.bot.shard.ids[0]}] ${info}`)})
    this.bot.on("warn", (info) => {
      console.log(`[WARN SHARD${this.bot.shard.ids[0]}] ${info}`)
    })
    this.bot.on("rateLimit", (err) => {
      console.error(`[RL SHARD${this.bot.shard.ids[0]}] ${JSON.stringify(err)}`)
    })
    this.bot.on("error", (err) => {
      console.error(`[ERR SHARD${this.bot.shard.ids[0]}] `, err)
    })
    this.bot.on("shardError", (err, id) => {
      console.error(`[WS SHARD${id}] ${JSON.stringify(err)}`)
    })
    this.bot.on("shardDisconnect", (event, id) => {
      console.error(`[WS SHARD${id}] ${JSON.stringify(event)}`)
    })
    process.on("unhandledRejection", (reason, promise) => {
      console.log("Unhandled Rejection at:", promise, "reason:", reason)
    })
    this.bot.on("ready", this.ready.bind(this))
    this.bot.on("guildMemberAdd", this.guildMemberAdd.bind(this))

    this.bot.on("message", this.message.bind(this))

    this.bot.on("invalidated", () => {
      // This should never happen!
      console.error(
        `Sesson on shard ${this.bot.shard.ids[0]} invalidated - exiting!`,
      )
      process.exit(0)
    })

    if (config.loud) {
      this.bot.on("error", (message) => console.log(message))
      process.on("unhandledRejection", (reason, promise) => {
        console.log("Unhandled rejection at:", promise, "reason:", reason)
      })
    }

    this.bot.dispatcher.addInhibitor((msg) => {
      if (!msg.guild) {
        return
      }

      if (this.blacklist[msg.guild.ownerID]) {
        msg.reply(
          "This server is blacklisted because you are banned from the RoVer support server.",
        )
        return "blacklisted"
      }
    })

    if (this.isPremium()) {
      this.bot.dispatcher.addInhibitor((msg) => {
        if (!msg.guild) return
        if (msg.command.name === "subscription") return

        const server = this.servers[msg.guild.id]

        if (server) {
          if (!server.isAuthorized()) {
            msg.reply(getUnauthorizedMessage(msg.member, server)) // notify sender to donate only if they're an "admin"
            return "not_premium"
          }
        } else {
          this.getServer(msg.guild.id).then((server) => {
            if (server.isAuthorized()) {
              if (msg.command) {
                msg.run()
              }
            } else {
              msg.reply(getUnauthorizedMessage(msg.member, server))
            }
          })
          return "not_sure_if_premium"
        }
      })
    }

    // Register commands
    this.bot.registry
      .registerGroup("rover", "RoVer")
      .registerDefaultTypes()
      .registerDefaultGroups()
      .registerDefaultCommands({
        ping: false,
        commandState: false,
        prefix: true,
        help: true,
        unknownCommand: false,
      })
      .registerCommandsIn(path.join(__dirname, "commands"))

    // Login.
    this.bot.login(process.env.CLIENT_TOKEN)

    this.updateBlacklist().catch(console.error)
  }

  isPremium() {
    return !!config.premium
  }

  async updateBlacklist() {
    if (!config.banServer) {
      return false
    }

    const response = await global.Cache.get("blacklists", "data")

    response.forEach((ban) => {
      this.blacklist[ban.user.id] = true
    })
  }

  /**
   * Called when the bot is ready and has logged in.
   * @listens Discord.Client#ready
   * @memberof DiscordBot
   */
  ready() {
    console.log(
      `Shard ${this.bot.shard.ids[0]} is ready, serving ${
        this.bot.guilds.cache.array().length
      } guilds.`,
    )

    // Set status message to the default until we get info from master process
    this.bot.user.setActivity("rover.link", { type: "LISTENING" })
  }

  /**
   * This method is called when a user sends a message, but it's used
   * for setting their nickname back to what it should be if they've
   * changed it. Only active if lockNicknames is true in config.
   * @listens Discord.Client#message
   * @param {Message} message The new message.
   * @memberof DiscordBot
   */
  async message(message) {
    // Don't want to do anything if this is a DM or message was sent by the bot itself.
    // Additionally, if the message is !verify, we don't want to run it twice (since it
    // will get picked up by the command anyway)
    if (
      !message.guild ||
      message.author.id === this.bot.user.id ||
      message.cleanContent.toLowerCase() ===
        message.guild.commandPrefix + "verify" ||
      message.author.bot
    ) {
      return
    }

    // We call discordMember.verify but we want to retain the cache
    // and we don't want it to post any announcements.
    const server = await this.getServer(message.guild.id)
    const member = await server.getMember(message.author.id)
    if (!member) return

    // If this is the verify channel, we want to delete the message and just verify the user if they aren't an admin.
    if (
      server.getSetting("verifyChannel") === message.channel.id &&
      message.cleanContent.toLowerCase() !==
        message.guild.commandPrefix + "verify" &&
      !(
        this.bot.isOwner(message.author) ||
        message.member.hasPermission("MANAGE_GUILD") ||
        message.member.roles.cache.find((role) => role.name === "RoVer Admin")
      )
    ) {
      if (
        message.channel.permissionsFor(message.guild.me).has("MANAGE_MESSAGES")
      ) {
        message.delete().catch(console.error)
      }
      return member.verify({ message })
    }

    if (
      !config.disableAutoUpdate &&
      member.shouldUpdateNickname(message.member.displayName) &&
      config.lockNicknames
    ) {
      // As a last resort, we just verify with cache on every message sent.
      await member.verify({
        announce: false,
        clearBindingsCache: false,
      })
    }
  }

  /**
   * This is called when a user joins any Discord server.
   * @listens Discord.Client#guildMemberAdd
   * @param {GuildMember} member The new guild member
   * @memberof DiscordBot
   */
  async guildMemberAdd(member) {
    if (member.user.bot) return

    const server = await this.getServer(member.guild.id)

    if (server.getSetting("joinDM") === false) {
      return
    }

    const discordMember = await server.getMember(member.id)
    if (!member) return

    // Check the guild's verification level
    const securityLevel = member.guild.verificationLevel
    const securityMessageIntro = `Welcome to ${member.guild.name}! This Discord server uses a Roblox account verification system to keep our community safe. Due to this server's security settings,`
    if (
      securityLevel === "MEDIUM" &&
      member.joinedTimestamp - member.user.createdTimestamp < 300000
    ) {
      member
        .send(
          `${securityMessageIntro} you must wait until your account is at least 5 minutes old to verify. Once the time is up, run \`${member.guild.commandPrefix}verify\` in the server to verify.`,
        )
        .catch(() => {})
      return
    } else if (securityLevel === "HIGH") {
      member
        .send(
          `${securityMessageIntro} you must wait 10 minutes to verify if you do not have a phone number linked to your Discord account. If you do have a linked phone number, you may immediately run \`${member.guild.commandPrefix}verify\` in the server.`,
        )
        .catch(() => {})
      return
    } else if (securityLevel === "VERY_HIGH") {
      member
        .send(
          `${securityMessageIntro} you must link your phone number to your Discord account. If you have already done so, you may run \`${member.guild.commandPrefix}verify\` in the server.`,
        )
        .catch(() => {})
      return
    }
    const action = await discordMember.verify()

    try {
      if (action.status) {
        member.send(server.getWelcomeMessage(action, member)).catch(() => {})
      } else if (!action.status && action.nonFatal) {
        member
          .send(
            `Welcome to ${member.guild.name}! You are already verified, but something went wrong when updating your roles. Try running \`${member.guild.commandPrefix}verify\` in the server for more information.`,
          )
          .catch(() => {})
      } else {
        member
          .send(
            `Welcome to ${
              member.guild.name
            }! This Discord server uses a Roblox account verification system to keep our community safe. Verifying your account is quick and safe and doesn't require any information other than your username. All you have to do is either join a game or put a code in your profile, and you're in!\n\nVisit the following link to verify your Roblox account: ${Util.getVerifyLink(
              member.guild,
            )}`,
          )
          .catch(() => {})
      }
    } catch (e) {}
  }

  /**
   * Sets the bot's status text.
   * @param {string} text The status message.
   * @param {string} activityType The activity type.
   * @memberof DiscordBot
   */
  setActivity(text, activityType) {
    if (!this.bot || !this.bot.user) return
  }

  /**
   * This is used to get the DiscordServer instance associated
   * with the specific guild id.
   * @param {Snowflake} id Guild id
   * @returns {Promise<DiscordServer>} DiscordServer
   * @memberof DiscordBot
   */
  async getServer(id) {
    if (!this.servers[id]) {
      this.servers[id] = new DiscordServer(this, id)
      await this.servers[id].loadSettings()
    } else if (!this.servers[id].areSettingsLoaded) {
      await this.servers[id].loadSettings()
    }
    return this.servers[id]
  }

  /**
   * This is called by the update server when a user verifies
   * online. It updates the member in every DiscordServer they
   * are in.
   * @param {object} args An object with keys `id` (string) and `guilds` (array)
   * @memberof DiscordBot
   */
  async globallyUpdateMember(args) {
    const { id, guilds } = args

    // Start off by clearing their global cache.
    await DiscordServer.clearMemberCache(id)

    let firstRun = true

    // Iterate through all of the guilds the bot is in.
    for (const guildId of guilds) {
      try {
        if (!this.bot.guilds.cache.has(guildId)) continue

        const guild = this.bot.guilds.resolve(guildId)
        const server = await this.getServer(guild.id)

        const member = await server.getMember(id)
        if (!member) continue
        if (
          (guild.verificationLevel === "MEDIUM" &&
            member.user.createdTimestamp < Date.now() - 300000) ||
          (guild.verificationLevel === "HIGH" &&
            member.joinedTimestamp < Date.now() - 600000) ||
          guild.verificationLevel === "VERY_HIGH"
        )
          continue
        const action = await member.verify({
          // We want to clear the group rank bindings cache because
          // this is the first iteration.
          clearBindingsCache: firstRun,
        })

        if (!action.status && !action.nonFatal) {
          // If there's a fatal error, don't continue with the rest.
          break
        } else if (action.status && server.hasCustomWelcomeMessage()) {
          // It worked, checking if there's a custom welcome message.
          await this.bot.users.fetch(id)

          const guildMember = await this.bot.guilds
            .resolve(guild.id)
            .members.fetch(id)
          guildMember
            .send(server.getWelcomeMessage(action, guildMember))
            .catch(() => {})
        }

        firstRun = false
      } catch (e) {
        continue
      }
    }
  }
}

module.exports = DiscordBot
