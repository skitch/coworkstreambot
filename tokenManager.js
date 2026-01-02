const fs = require("fs");
const axios = require("axios");
require("dotenv").config();

const TOKENS_FILE = "./tokens.json";

function saveTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    return JSON.parse(fs.readFileSync(TOKENS_FILE));
  }
  return {};
}

async function getValidToken() {
  let tokens = loadTokens();

  if (tokens.access_token) {
    try {
      await axios.get("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${tokens.access_token}` },
      });
      console.log("✅ Existing Access Token is valid.");
      return tokens.access_token;
    } catch (error) {
      console.log("⚠️ Access Token expired or invalid. Refreshing...");
    }
  }

  const refreshToken = tokens.refresh_token || process.env.TWITCH_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("❌ No Refresh Token found in tokens.json or .env!");
  }

  try {
    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      null,
      {
        params: {
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
      },
    );

    const newTokens = response.data;

    saveTokens({
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token,
    });

    console.log("🔄 Token Refreshed Successfully!");
    return newTokens.access_token;
  } catch (error) {
    console.error(
      "❌ Failed to refresh token:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

module.exports = { getValidToken };
