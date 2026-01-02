require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const fs = require("fs");
const path = require("path");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const { getValidToken } = require("./tokenManager");
const session = require("express-session");

// Configuration and initialization
const DATA_DIR = "./data";
const CHANNELS_FILE = "./channels.json";
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback_dev_secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Set to true if using HTTPS
  }),
);

// Global config object to store { "channel": "password" }
let channelAuth = {};

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE));

      if (Array.isArray(data)) {
        console.log("⚠️ Migrating channels.json to new password format...");
        const newAuth = {};
        data.forEach((chan) => {
          // Default password for existing users during migration
          newAuth[chan.toLowerCase()] = "password123";
        });
        channelAuth = newAuth;
        saveChannelList(channelAuth); // Save the new format immediately
        return Object.keys(newAuth);
      }

      channelAuth = data;
      return Object.keys(data);
    } else {
      const defUser = process.env.DEFAULT_CHANNEL || "admin";
      const defPass = process.env.DEFAULT_PASS || "password";

      channelAuth = { [defUser]: defPass };
      saveChannelList(channelAuth);
      return [defUser];
    }
  } catch (e) {
    console.error("Error loading channels.json:", e);
    return [];
  }
}

function saveChannelList(authData) {
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(authData, null, 2));
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Initialize channel list
let targetChannels = loadChannels();

let client;
let channelStates = {};

async function startBot() {
  targetChannels = loadChannels();

  targetChannels.forEach((chan) => {
    channelStates[chan] = loadChannelData(chan);
    channelStates[chan].timerStatus = "paused";
    channelStates[chan].timerInterval = null;
    channelStates[chan].sessionStats = {};
  });

  console.log("🔐 Authenticating with Twitch...");
  let newToken;
  try {
    newToken = await getValidToken();
  } catch (e) {
    console.error("Critical Auth Error:", e.message);
    process.exit(1);
  }

  const botUser = process.env.BOT_USERNAME;

  client = new tmi.Client({
    options: { debug: false },
    identity: {
      username: botUser,
      password: `oauth:${newToken}`,
    },
    channels: targetChannels,
  });

  client.connect().catch(console.error);

  // Twitch command logic
  client.on("message", (channel, tags, message, self) => {
    try {
      if (self) return;
      const chanName = channel.replace("#", "");
      if (!message.startsWith("!")) return; // Only process and log if it starts with !
      const state = channelStates[chanName];
      if (!state) return;

      const args = message.split(" ");
      const command = args.shift().toLowerCase();
      const username = tags["display-name"];
      const isMod = tags.mod || tags["user-id"] === tags["room-id"];

      // Log the incoming command
      console.log(
        `[COMMAND] #${chanName} | ${username}: ${command} ${args.join(" ")}`,
      );

      // !help:
      if (command === "!coworkhelp") {
        // 1. Base commands everyone can see
        let helpMessage = `🤖 [VIEWER] !task <task text>, !edit <task number> <new task text>, !done <task number>`;

        // 2. Add Mod/Streamer commands if user is a mod/streamer
        if (isMod) {
          helpMessage += ` | 🛠️ [MOD] !focus/!break <mins>, !coworktheme <color>, !coworksetgoal <num>, !coworkclearstats, !coworkclearleaderboard, !coworkblock/!coworkunblock <user>`;
        }

        botLog(channel, helpMessage);
      }

      // !task
      if (command === "!task") {
        const taskText = args.join(" ");
        if (taskText) {
          CoreActions.addTask(chanName, username, taskText);
        }
      }

      // !done [index]
      if (command === "!done") {
        const msg = CoreActions.markTaskDone(chanName, username, args[0]);
        if (msg) botLog(channel, msg);
      }

      // !edit <id> <new text>
      if (command === "!edit") {
        const taskId = args[0];
        const newText = args.slice(1).join(" "); // Re-join the rest of the message

        if (taskId && newText) {
          const msg = CoreActions.editTask(chanName, username, taskId, newText);
          if (msg) botLog(channel, msg);
        } else {
          botLog(channel, `⛔ Usage: !edit <id> <new text>`);
        }
      }

      // !focus / !break
      if ((command === "!focus" || command === "!break") && isMod) {
        const mode = command === "!focus" ? "WORK" : "BREAK";
        const defaultTime = mode === "WORK" ? 25 : 5;
        const mins = parseInt(args[0]) || defaultTime;

        const msg = CoreActions.startSession(chanName, mins, mode);
        botLog(channel, msg);
      }

      // !pause
      if (command === "!pause" && isMod) {
        const msg = CoreActions.pauseSession(chanName);
        if (msg) botLog(channel, msg);
      }

      // !resume
      if (command === "!resume" && isMod) {
        const msg = CoreActions.resumeSession(chanName);
        if (msg) botLog(channel, msg);
      }

      // !coworktheme
      if (command === "!coworktheme" && isMod) {
        const msg = CoreActions.setTheme(chanName, args[0]?.toLowerCase());
        if (msg) client.say(channel, msg);
      }

      // !coworklayout
      if (command === "!coworklayout" && isMod) {
        const msg = CoreActions.setLayout(chanName, args[0]?.toLowerCase());
        if (msg) botLog(channel, msg);
      }

      // !coworksetgoal
      if (command === "!coworksetgoal" && isMod) {
        const newGoal = parseInt(args[0]);
        if (!isNaN(newGoal) && newGoal > 0) {
          const msg = CoreActions.setGoal(chanName, newGoal);
          if (msg) client.say(channel, msg);
        }
      }

      // !coworkcleartasks
      if (
        (command === "!coworkcleartasks" || command === "!cleartasks") &&
        isMod
      ) {
        const msg = CoreActions.clearTasks(chanName);
        if (msg) client.say(channel, msg);
      }

      // !coworkclearstats
      if (command === "!coworkclearstats" && isMod) {
        const msg = CoreActions.clearStats(chanName);
        if (msg) client.say(channel, msg);
      }

      // !coworkclearleaderboard
      if (command === "!coworkclearleaderboard" && isMod) {
        const msg = CoreActions.clearLeaderboard(chanName);
        if (msg) client.say(channel, msg);
      }

      // !coworkblock
      if (command === "!coworkblock" && isMod && args[0]) {
        const msg = CoreActions.blockUser(chanName, args[0]);
        if (msg) client.say(channel, msg);
      }

      // !coworkunblock
      if (command === "!coworkunblock" && isMod && args[0]) {
        const msg = CoreActions.unblockUser(chanName, args[0]);
        if (msg) client.say(channel, msg);
      }
    } catch (err) {
      console.error(`Error in channel ${channel}:`, err);
    }
  });

  // Routing
  // Overlay
  app.get("/overlay", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "overlay.html"));
  });

  // landing page
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Dashboard
  app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
  });

  // Login endpoint
  app.post("/api/login", (req, res) => {
    const { channel, password } = req.body;
    const target = channel.toLowerCase();

    // Look up the password in our loaded config
    // We check if the channel exists AND if the password matches
    if (channelAuth[target] && channelAuth[target] === password) {
      req.session.authenticated = true;
      req.session.channel = target;
      res.json({
        success: true,
        // Send the value from .env, or null if not set
        publicUrl: process.env.PUBLIC_URL || null,
      });
    } else {
      res
        .status(401)
        .json({ success: false, message: "Invalid Channel or Password" });
    }
  });

  // API middleware to protect routes
  function requireAuth(req, res, next) {
    if (req.session.authenticated && req.session.channel) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Control endpoints
  app.post("/api/command", requireAuth, (req, res) => {
    const { action, payload } = req.body;
    const chanName = req.session.channel;

    let msg = null;

    if (action === "start-timer") {
      msg = CoreActions.startSession(chanName, payload.minutes, payload.mode);
    } else if (action === "pause") {
      msg = CoreActions.pauseSession(chanName);
    } else if (action === "resume") {
      msg = CoreActions.resumeSession(chanName);
    } else if (action === "set-theme") {
      msg = CoreActions.setTheme(chanName, payload.theme);
    } else if (action === "set-layout") {
      msg = CoreActions.setLayout(chanName, payload.layout);
    } else if (action === "set-goal") {
      const val = parseInt(payload.goal);
      if (!isNaN(val) && val > 0) msg = CoreActions.setGoal(chanName, val);
    } else if (action === "clear-tasks") {
      msg = CoreActions.clearTasks(chanName);
    } else if (action === "block-user") {
      msg = CoreActions.blockUser(chanName, payload.username);
    } else if (action === "unblock-user") {
      msg = CoreActions.unblockUser(chanName, payload.username);
    } else if (action === "add-task") {
      // Determine user (Payload > Session > Default)
      let targetUser = payload.username || req.session.channel;
      // Case-insensitive match logic
      const state = channelStates[chanName];
      if (state) {
        const match = Object.keys(state.activeTasks).find(
          (u) => u.toLowerCase() === targetUser.toLowerCase(),
        );
        if (match) targetUser = match;
        CoreActions.addTask(chanName, targetUser, payload.text);
      }
    } else if (action === "mark-done") {
      // Dashboard needs to send: { username: "user", taskId: 1 }
      const msg = CoreActions.markTaskDone(
        chanName,
        payload.username,
        payload.taskId,
      );
      if (msg) botLog(`#${chanName}`, msg);
    } else if (action === "edit-task") {
      // Dashboard needs to send: { username: "user", taskId: 1, text: "New text" }
      const msg = CoreActions.editTask(
        chanName,
        payload.username,
        payload.taskId,
        payload.text,
      );
      if (msg) botLog(`#${chanName}`, msg);
    }

    // Log if a message was generated
    if (msg) botLog(`#${chanName}`, `${msg}`);

    res.json({ success: true });
  });

  // Serve the html
  app.use(express.static("public"));
  // Advertise the bot status in the terminal
  server.listen(PORT, () => console.log(`Bot is running on port ${PORT}`));
  client.on("connected", () => {
    console.log("------------------------------------------");
    console.log(`🚀 ${botUser} IS LIVE`);
    console.log(`📡 Connected to: ${targetChannels.join(", ")}`);
    console.log(`📁 Data Directory: ${path.resolve(DATA_DIR)}`);
    console.log("------------------------------------------");
  });
}

function startTimer(chanName, minutes, mode) {
  const state = channelStates[chanName];

  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  state.timerMode = mode;
  state.timerStatus = "running";

  // If no minutes are passed, it uses the existing timerSeconds (Resume)
  if (minutes !== undefined && minutes !== null) {
    state.timerSeconds = Math.ceil(minutes * 60);
  }

  broadcastUpdate(chanName);

  state.timerInterval = setInterval(() => {
    if (state.timerSeconds > 0) {
      state.timerSeconds--;
      broadcastUpdate(chanName);
      if (state.timerSeconds % 10 === 0) saveChannelData(chanName);
    } else {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
      state.timerStatus = "paused";

      saveChannelData(chanName);
      io.to(chanName).emit("timer-end");

      if (state.timerMode === "WORK") {
        const participants = Object.entries(state.sessionStats || {}).sort(
          ([, a], [, b]) => b - a,
        );

        if (participants.length > 0) {
          // 1. Determine the highest score
          const maxScore = participants[0][1];

          // 2. Separate the leaders from the rest
          const leaders = participants.filter(
            ([, count]) => count === maxScore,
          );
          const others = participants.filter(([, count]) => count < maxScore);

          // 3. Format the MVP string
          let summary = "";
          const leaderNames = leaders.map(([name]) => `@${name}`).join(" & ");

          if (leaders.length > 1) {
            summary = `🏆 Co-MVPs: ${leaderNames} with ${maxScore} tasks each! `;
          } else {
            summary = `🏆 Session MVP: ${leaderNames} with ${maxScore} tasks! `;
          }

          // 4. Add the rest of the people who completed tasks
          if (others.length > 0) {
            const runnerUps = others
              .map(([name, count]) => `${name} (${count})`)
              .join(", ");
            summary += `Everyone else did great too! - ${runnerUps}. `;
          }

          summary += `Enjoy the break! ☕`;
          botLog(`#${chanName}`, summary);
        }
        // Reset session stats and clear completed tasks
        state.sessionStats = {};
        Object.keys(state.activeTasks).forEach((user) => {
          state.activeTasks[user] = state.activeTasks[user].filter(
            (t) => !t.completed,
          );
          state.activeTasks[user].forEach((t, i) => (t.id = i + 1));

          io.to(chanName).emit("refresh-tasks", {
            user: user,
            tasks: state.activeTasks[user],
          });
        });

        saveChannelData(chanName);

        // Start the break
        setTimeout(() => startTimer(chanName, 5, "BREAK"), 2000);
      } else {
        client.say(`#${chanName}`, `🔔 Break is over! Back to work! 🔥`);
      }
    }
  }, 1000);
}

function stopTimer(chanName) {
  const state = channelStates[chanName];
  if (state && state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state) state.timerStatus = "paused";
}

function broadcastUpdate(chanName) {
  const s = channelStates[chanName];
  io.to(chanName).emit("timer-update", {
    seconds: s.timerSeconds,
    status: s.timerStatus,
    mode: s.timerMode,
  });
}

function saveChannelData(chanName) {
  const { timerInterval, ...dataToSave } = channelStates[chanName];
  const filePath = path.join(DATA_DIR, `${chanName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
}

function loadChannelData(chanName) {
  const filePath = path.join(DATA_DIR, `${chanName}.json`);

  // Default structure
  let defaultData = {
    activeTasks: {},
    totalCompleted: 0,
    dailyGoal: 20,
    userStats: {},
    blocklist: [],
    currentTheme: "pink",
    currentLayout: "comfortable",
    timerSeconds: 1500,
    timerMode: "WORK",
    timerStatus: "paused",
    sessionStats: {},
  };

  if (fs.existsSync(filePath)) {
    try {
      const savedData = JSON.parse(fs.readFileSync(filePath));
      // Merge saved data ON TOP of defaults
      return { ...defaultData, ...savedData };
    } catch (e) {
      console.error("Error reading data file:", e);
      return defaultData;
    }
  }
  return defaultData;
}

// Logs the bot's output to the terminal
function botLog(channel, msg) {
  console.log(`[REPLY] ${channel}: ${msg}`);
  client.say(channel, msg);
}

io.on("connection", (socket) => {
  const chanName = socket.handshake.query.channel;
  if (!chanName || !channelStates[chanName]) return;

  const state = channelStates[chanName];
  socket.join(chanName);

  socket.emit("init-tasks", getCleanState(chanName));

  socket.emit("timer-update", {
    seconds: state.timerSeconds,
    status: state.timerStatus,
    mode: state.timerMode,
  });
});

function getCleanState(chanName) {
  const state = channelStates[chanName];
  if (!state) return null;

  const cleanState = { ...state };
  delete cleanState.timerInterval;

  return cleanState;
}

// List of all the actions that can be done
// the /api/command and client.on("message" sections just call these commands
const CoreActions = {
  // Task management
  markTaskDone: (chanName, username, requestedId) => {
    const state = channelStates[chanName];
    if (!state) return null;

    const userTasks = state.activeTasks[username];
    if (!userTasks || userTasks.length === 0) return null;

    // Default to first task (index 0) unless a specific ID is found
    let taskIndex = 0;
    if (requestedId) {
      const foundIndex = userTasks.findIndex(
        (t) => t.id === parseInt(requestedId),
      );
      if (foundIndex !== -1) taskIndex = foundIndex;
    }

    const task = userTasks[taskIndex];
    // If it's already done, maybe we don't want to re-count it?
    // For now, let's assume users won't spam !done on the same task.
    task.completed = true;

    // Update stats
    state.totalCompleted++;
    if (!state.userStats) state.userStats = {};
    state.userStats[username] = (state.userStats[username] || 0) + 1;
    state.sessionStats[username] = (state.sessionStats[username] || 0) + 1;

    saveChannelData(chanName);

    // Refresh UI
    io.to(chanName).emit("refresh-tasks", { user: username, tasks: userTasks });
    io.to(chanName).emit("milestone-update", { total: state.totalCompleted });

    const leaderboard = Object.entries(state.userStats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));
    io.to(chanName).emit("leaderboard-update", { leaderboard });

    return `✅ ${username} checked off: "${task.text}"`;
  },

  editTask: (chanName, username, taskId, newText) => {
    const state = channelStates[chanName];
    if (!state) return null;

    const userTasks = state.activeTasks[username];
    if (!userTasks) return null;

    const id = parseInt(taskId);
    if (isNaN(id) || !newText) return null;

    const taskIndex = userTasks.findIndex((t) => t.id === id);

    if (taskIndex !== -1) {
      userTasks[taskIndex].text = newText;
      saveChannelData(chanName);

      io.to(chanName).emit("refresh-tasks", {
        user: username,
        tasks: userTasks,
      });
      return `📝 Task #${id} updated for ${username}!`;
    } else {
      return `⚠️ Could not find task #${id} for you.`;
    }
  },

  // Session management
  clearTasks: (chanName) => {
    const state = channelStates[chanName];
    if (!state) return null;

    state.activeTasks = {};
    saveChannelData(chanName);

    io.to(chanName).emit("clear-board-ui");
    io.to(chanName).emit("in-progress-update", { count: 0 });
    io.to(chanName).emit("milestone-update", { total: state.totalCompleted });

    // Refresh leaderboard
    const leaderboard = Object.entries(state.userStats || {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));
    io.to(chanName).emit("leaderboard-update", { leaderboard });

    return "🧹 The task board has been wiped clean! (Leaderboard preserved)";
  },

  clearStats: (chanName) => {
    const state = channelStates[chanName];
    if (!state) return null;

    state.totalCompleted = 0;
    state.userStats = {};
    saveChannelData(chanName);

    io.to(chanName).emit("milestone-update", { total: 0 });
    io.to(chanName).emit("leaderboard-update", { leaderboard: [] });
    io.to(chanName).emit("goal-update", { dailyGoal: state.dailyGoal });

    return "📊 All session stats and the leaderboard have been reset!";
  },

  clearLeaderboard: (chanName) => {
    const state = channelStates[chanName];
    if (!state) return null;

    state.userStats = {};
    saveChannelData(chanName);
    io.to(chanName).emit("leaderboard-update", { leaderboard: [] });

    return "📊 The leaderboard has been reset!";
  },

  setGoal: (chanName, newGoal) => {
    const state = channelStates[chanName];
    if (!state) return null;

    state.dailyGoal = newGoal;
    saveChannelData(chanName);
    io.to(chanName).emit("goal-update", { dailyGoal: newGoal });

    return `🎯 Daily goal set to ${newGoal} tasks!`;
  },

  // Timer controls
  startSession: (chanName, mins, mode) => {
    startTimer(chanName, mins, mode);
    return `📱 Session started: ${mode} (${mins}m)`;
  },

  pauseSession: (chanName) => {
    const state = channelStates[chanName];
    if (state && state.timerStatus === "running") {
      stopTimer(chanName);
      saveChannelData(chanName);
      broadcastUpdate(chanName);
      return "⏸️ Timer paused.";
    }
    return null;
  },

  resumeSession: (chanName) => {
    const state = channelStates[chanName];
    if (state && state.timerStatus === "paused" && state.timerSeconds > 0) {
      const minsRemaining = state.timerSeconds / 60;
      startTimer(chanName, minsRemaining, state.timerMode);
      return "▶️ Timer resumed.";
    }
    return null;
  },

  // Visuals
  setTheme: (chanName, theme) => {
    const state = channelStates[chanName];
    const validThemes = ["pink", "blue", "purple", "gold"];

    if (validThemes.includes(theme)) {
      state.currentTheme = theme;
      saveChannelData(chanName);
      io.to(chanName).emit("theme-update", theme);
      return `🎨 Theme updated to ${theme}!`;
    }
    return null;
  },

  setLayout: (chanName, layout) => {
    const state = channelStates[chanName];
    const validLayouts = ["compact", "comfortable"];

    if (validLayouts.includes(layout)) {
      state.currentLayout = layout;
      saveChannelData(chanName);
      io.to(chanName).emit("layout-update", layout);
      return `📏 Layout set to ${layout}!`;
    }
    return null;
  },

  // User management
  blockUser: (chanName, targetUser) => {
    const state = channelStates[chanName];
    const target = targetUser.toLowerCase();

    if (!state.blocklist.includes(target)) {
      state.blocklist.push(target);
      saveChannelData(chanName);
      io.to(chanName).emit("blocklist-update", state.blocklist);
      return `🚫 ${target} has been blocked from the task overlay.`;
    }
    return null;
  },

  unblockUser: (chanName, targetUser) => {
    const state = channelStates[chanName];
    const target = targetUser.toLowerCase();

    state.blocklist = state.blocklist.filter((u) => u !== target);
    saveChannelData(chanName);
    io.to(chanName).emit("blocklist-update", state.blocklist);
    return `✅ ${target} has been unblocked.`;
  },

  // Task logic
  addTask: (chanName, user, text) => {
    const state = channelStates[chanName];
    // Check blocklist
    if (state.blocklist && state.blocklist.includes(user.toLowerCase()))
      return null;

    // Ensure array exists
    if (!state.activeTasks[user]) state.activeTasks[user] = [];

    const newTask = {
      id: state.activeTasks[user].length + 1,
      text: text,
    };

    state.activeTasks[user].push(newTask);
    saveChannelData(chanName);

    io.to(chanName).emit("refresh-tasks", {
      user: user,
      tasks: state.activeTasks[user],
    });

    const totalInProgress = Object.values(state.activeTasks).reduce(
      (acc, val) => acc + val.length,
      0,
    );
    io.to(chanName).emit("in-progress-update", { count: totalInProgress });

    return true;
  },
};

startBot();
