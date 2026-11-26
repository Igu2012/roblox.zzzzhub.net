"use strict";

// Export the native Node server so Vercel can handle both HTTP requests and
// WebSocket upgrade events when Fluid Compute is enabled.
module.exports = require("../server").server;
