'use strict';
// /api/admin/login  POST: check the password and start a 12-hour sign-in.
// The work is in api/_admin.js.
const { handleLogin } = require('../_admin');

module.exports = (req, res) => handleLogin(req, res);
