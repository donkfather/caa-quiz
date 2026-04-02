const config = require("./app.json");

config.expo.extra.useTestAds = process.env.EXPO_PUBLIC_USE_TEST_ADS === "true";

module.exports = config;
