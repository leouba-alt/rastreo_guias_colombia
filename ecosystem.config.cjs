module.exports = {
  apps: [
    {
      name: "rastreo_guias_colombia",
      script: "server.js",
      env: {
        PORT: 3000,
        TRACK_TIMEOUT_MS: 30000,
        TRACK_CACHE_TTL_MS: 300000
      }
    }
  ]
};
