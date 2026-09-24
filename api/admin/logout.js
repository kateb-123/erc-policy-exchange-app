'use strict';
// /api/admin/logout  POST: end the sign-in.
// The work is in api/_admin.js.
const { handleLogout } = require('../_admin');

module.exports = (req, res) => handleLogout(req, res);
