// This file is the entry point for the bot.

const path = require("path")
const request = require("request-promise")
const Discord = require("discord.js")
const { GlobalCache } = require("./GlobalCache")
const config = require("./data/client.json")
const updateServer = require("./UpdateServer.js")
const Util = require("./Util.js")

// Set up the sharding manager, a helper class that separates handling
// guilds into grouped processes called Shards.
const shardingManager = new Discord.ShardingManager(
  path.join(__dirname, "Shard.js"),
  {
    token: process.env.token,
    totalShards: config.totalShards || "auto",
    shardArgs: typeof v8debug === "object" ? ["--inspect"] : undefined,
    execArgv: ["--trace-warnings"],
  },
)

shardingManager.on("shardCreate", (shard) => {
  console.log(`Launching shard ${shard.id + 1}/${shardingManager.totalShards}`)
})

// Instantiate a GlobalCache, which will cache information from the shards.
global.GlobalCache = new GlobalCache(shardingManager)
;(async () => {
  if (config.banServer) {
    const res = await request(
      `https://discord.com/api/v9/guilds/${config.banServer}/bans`,
      {
        headers: {
          authorization: `Bot ${config.token}`,
        },
        json: true,
        resolveWithFullResponse: true,
        simple: false,
      },
    ).catch((e) => console.error(e))
    if (res && res.statusCode === 200) global.GlobalCache.setBlacklist(res.body)
  }
  await shardingManager.spawn(config.totalShards || "auto", 8000, -1)
})()

// Set bot status messages
let currentActivity = 0
let totalUsers = null

async function getNextActivity() {
  currentActivity++
  if (currentActivity === 2 && totalUsers == null) currentActivity++

  if (currentActivity > 3) {
    currentActivity = 0
  }

  switch (currentActivity) {
    case 0:
      return { text: "jave" }
    case 1: {
      let totalGuilds = (
        await shardingManager.fetchClientValues("guilds.cache.size")
      ).reduce((prev, val) => prev + val, 0)
      totalGuilds = Util.toHumanReadableNumber(totalGuilds)
      return { text: `${totalGuilds} servers`, type: "WATCHING" }
    }
    case 2:
      return { text: `${totalUsers} users`, type: "LISTENING" }
    case 3:
      return { text: "!verify", type: "LISTENING" }
  }
}

request("https://verify.eryn.io/api/count").then((count) => {
  totalUsers = Util.toHumanReadableNumber(count)
})

/*setInterval(async () => {
  if (shardingManager.shards.size === shardingManager.totalShards) {
    shardingManager.broadcast({
      action: 'status',
      argument: await getNextActivity()
    })
  }
}, 15000)*/

// If updateServer is defined, start that up as well.
if (config.updateServer) {
  updateServer(shardingManager, config.updateServer)
}

if (config.mainLifeTime) {
  setTimeout(() => {
    shardingManager.respawn = false
    shardingManager.broadcastEval("process.exit()")
  }, config.mainLifeTime * 1000)

  setTimeout(() => {
    process.exit()
  }, (config.mainLifeTime + 5) * 1000)
}

// Client.json documentation:
/*
    "token"             : String. The bot token that is used to log in to your bot.
    "lockNicknames"     : Boolean. Default false. If true, the bot will run DiscordServer.verifyMember every time
                          they begin typing. This will quickly eat up API requests if you aren't careful. Mostly
                          used on the hosted version.
    "updateServer"      : {
                          If this object is present, the update server will be started.

        "port"          : Integer. The port the Update server runs on.
        "apiKey"        : String. The API key the server checks against before updating the user.
    }
    "loud"              : Boolean. Default false. Logs every request made to stdout.
    "totalShards"       : Integer. Default auto. The number of shards to launch.
    "apiRequestMethod"  : String. Default 'sequential'. sequential' or 'burst'. Sequential executes all requests in the order
                          they are triggered, whereas burst runs multiple at a time, and doesn't guarantee a particular order.
    "owner"             : String. Default "0". The Discord ID of the bot's owner.
    "commandPrefix"     : String. Default "!". The prefix for commands.
    "shardLifeTime"     : Integer. Number of seconds each shard will run before closing.
    "mainLifeTime"      : Integer. Number of seconds the main process will run before closing.
    "cookie"            : String. The .ROBLOSECURITY cookie of the bot account used to fetch premium information of a user.
                          (Not required if you're not using the premium virtualgroup, but whois will not report premium information correctly)
    "invite"            : String. The bot invite link.
    "disableAutoUpdate" : Boolean. Disables auto update feature.
*/
